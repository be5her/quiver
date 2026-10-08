import { X509Certificate, constants, createHmac, createPrivateKey, createPublicKey, timingSafeEqual, verify, type KeyObject, type webcrypto } from 'node:crypto';
import { QuiverError } from '../errors';
import { relativeTime } from '../time';

type Family = 'hmac' | 'rsa' | 'pss' | 'ec' | 'eddsa';

interface Algorithm {
  family: Family;
  hash: string | null;
  /** The curve an EC or EdDSA key must be on (EdDSA accepts either when unset). */
  curve?: string;
}

const ALGORITHMS: Record<string, Algorithm> = {
  HS256: { family: 'hmac', hash: 'sha256' },
  HS384: { family: 'hmac', hash: 'sha384' },
  HS512: { family: 'hmac', hash: 'sha512' },
  RS256: { family: 'rsa', hash: 'sha256' },
  RS384: { family: 'rsa', hash: 'sha384' },
  RS512: { family: 'rsa', hash: 'sha512' },
  PS256: { family: 'pss', hash: 'sha256' },
  PS384: { family: 'pss', hash: 'sha384' },
  PS512: { family: 'pss', hash: 'sha512' },
  ES256: { family: 'ec', hash: 'sha256', curve: 'prime256v1' },
  ES384: { family: 'ec', hash: 'sha384', curve: 'secp384r1' },
  ES512: { family: 'ec', hash: 'sha512', curve: 'secp521r1' },
  ES256K: { family: 'ec', hash: 'sha256', curve: 'secp256k1' },
  EdDSA: { family: 'eddsa', hash: null },
  Ed25519: { family: 'eddsa', hash: null, curve: 'ed25519' },
  Ed448: { family: 'eddsa', hash: null, curve: 'ed448' },
};

/** Every `alg` `verifyJwt` checks. */
export const JWT_ALGORITHMS = Object.keys(ALGORITHMS);

const CURVE_NAMES: Record<string, string> = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521', secp256k1: 'secp256k1', ed25519: 'Ed25519', ed448: 'Ed448' };

export interface JwtVerification {
  /** The signature matches, the token is within exp and nbf, and the issuer is the one asked for. */
  valid: boolean;
  /** What makes it invalid, in words; empty when valid. */
  problems: string[];
  algorithm: string;
  /** The signature matches the key, whatever the claims say. */
  signatureValid: boolean;
  /** How the key was read: `secret`, `PEM`, `base64 PEM`, `base64 key`, `certificate`, `JWK` or `JWK set`. */
  keyFormat: string;
  /** The `kid` of the JWK that was checked, when it has one. */
  kid: string | null;
}

export interface JwtVerifyOptions {
  /** The secret is base64, not text. */
  base64Secret?: boolean;
  /** Leeway for exp and nbf, as servers allow for clocks that drift. */
  clockSkewSeconds?: number;
  /** The `iss` the token must carry. Not checked when unset. */
  issuer?: string;
  /** The time to check exp and nbf against, in milliseconds. Defaults to now. */
  now?: number;
}

type Key = { kind: 'secret'; secret: Buffer; format: string; kid: string | null } | { kind: 'public'; key: KeyObject; format: string; kid: string | null };

function invalid(message: string): QuiverError {
  return new QuiverError('INVALID_INPUT', message);
}

/**
 * The three parts of a token pasted on its own or as an Authorization header value: `Bearer`,
 * the `jwt` scheme some APIs use, and a leading `Authorization:` are dropped.
 */
export function jwtParts(token: string): [header: string, payload: string, signature: string] {
  const parts = token
    .trim()
    .replace(/^authorization:\s*/i, '')
    .replace(/^(bearer|jwt)\s+/i, '')
    .trim()
    .split('.');
  if (parts.length !== 3) throw invalid('A JWT has three dot-separated parts');
  return parts as [string, string, string];
}

function decodePart(part: string, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw invalid(`The JWT ${name} is not base64url-encoded JSON`);
}

/** Why the claims make the token invalid at `now`: expired, not yet valid, another issuer. */
function claimProblems(payload: Record<string, unknown>, options: JwtVerifyOptions): string[] {
  const now = options.now ?? Date.now();
  const skew = (options.clockSkewSeconds ?? 0) * 1000;
  const problems: string[] = [];
  if (typeof payload.exp === 'number' && now >= payload.exp * 1000 + skew) {
    problems.push(`expired ${relativeTime(payload.exp * 1000 - now)} (${new Date(payload.exp * 1000).toISOString()})`);
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf * 1000 - skew) {
    problems.push(`not valid until ${new Date(payload.nbf * 1000).toISOString()} (${relativeTime(payload.nbf * 1000 - now)})`);
  }
  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    problems.push(typeof payload.iss === 'string' ? `issuer is "${payload.iss}", expected "${options.issuer}"` : `no issuer, expected "${options.issuer}"`);
  }
  return problems;
}

function fromJwk(jwk: Record<string, unknown>, format: string): Key {
  const kid = typeof jwk.kid === 'string' ? jwk.kid : null;
  if (jwk.kty === 'oct') {
    if (typeof jwk.k !== 'string') throw invalid('The JWK has kty "oct" but no "k"');
    return { kind: 'secret', secret: Buffer.from(jwk.k, 'base64url'), format, kid };
  }
  try {
    return { kind: 'public', key: createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: 'jwk' }), format, kid };
  } catch (err) {
    throw invalid(`Cannot read the JWK${kid ? ` "${kid}"` : ''}: ${(err as Error).message}`);
  }
}

/** Each way DER can hold a key, tried in turn: whatever the PEM label says, the bytes decide. */
const DER_READERS: [certificate: boolean, read: (der: Buffer) => KeyObject][] = [
  [false, (der) => createPublicKey({ key: der, format: 'der', type: 'spki' })],
  [false, (der) => createPublicKey({ key: der, format: 'der', type: 'pkcs1' })],
  [true, (der) => new X509Certificate(der).publicKey],
  [false, (der) => createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))],
  [false, (der) => createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs1' }))],
  [false, (der) => createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'sec1' }))],
];

/**
 * A key or certificate as base64 DER, with or without PEM lines around it, or null when the text
 * is not one. Reading the bytes rather than the label accepts an `x5c` certificate or a PKCS#1 key
 * pasted under "BEGIN PUBLIC KEY", and line breaks kept as `\n` by a JSON or .env value.
 */
function readDer(text: string): { key: KeyObject; certificate: boolean } | null {
  const body = text
    .replace(/-----(BEGIN|END)[^-]*-----/g, '')
    .replace(/\\r|\\n/g, '')
    .replace(/\s+/g, '');
  // DER starts with a SEQUENCE (0x30), which is "M" in base64.
  if (!/^M[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const der = Buffer.from(body, 'base64');
  for (const [certificate, read] of DER_READERS) {
    try {
      return { key: read(der), certificate };
    } catch {
      // Not this kind; try the next.
    }
  }
  return null;
}

/**
 * The PEM inside a base64-wrapped PEM, the form an environment variable often carries a key in
 * (`LS0tLS1CRUdJTi…` is "-----BEGIN"), or null when the text is not one.
 */
function unwrapPem(text: string): string | null {
  const body = text.replace(/\s+/g, '');
  if (!/^LS0tLS1/.test(body)) return null;
  const decoded = Buffer.from(body, 'base64').toString('utf8').trim();
  return decoded.startsWith('-----BEGIN') ? decoded : null;
}

/** A secret, a PEM (plain or base64-wrapped) or base64 DER key or certificate, a JWK, or a JWK set, as the keys it holds. */
function readKeys(text: string, base64Secret: boolean): Key[] {
  const trimmed = text.trim();
  if (!trimmed) throw invalid('Give a secret or a public key to verify against');
  const pem = trimmed.startsWith('-----BEGIN') ? trimmed : unwrapPem(trimmed);
  if (pem) {
    const read = readDer(pem);
    if (!read) throw invalid('Cannot read the PEM key: what is between the BEGIN and END lines is not a public key, certificate or private key');
    return [{ kind: 'public', key: read.key, format: read.certificate ? 'certificate' : pem === trimmed ? 'PEM' : 'base64 PEM', kid: null }];
  }
  if (trimmed.startsWith('{')) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      throw invalid(`The key looks like a JWK but is not valid JSON: ${(err as Error).message}`);
    }
    if (Array.isArray(json.keys)) return (json.keys as Record<string, unknown>[]).map((jwk) => fromJwk(jwk, 'JWK set'));
    if (typeof json.kty === 'string') return [fromJwk(json, 'JWK')];
    throw invalid('A JWK needs "kty", a JWK set needs "keys"');
  }
  // Bare base64 DER, like Keycloak's realm public key or a JWK's x5c entry.
  const read = readDer(trimmed);
  if (read) return [{ kind: 'public', key: read.key, format: read.certificate ? 'certificate' : 'base64 key', kid: null }];
  return [{ kind: 'secret', secret: base64Secret ? Buffer.from(trimmed, 'base64') : Buffer.from(trimmed, 'utf8'), format: 'secret', kid: null }];
}

function keyName(key: Key): string {
  if (key.kind === 'secret') return 'a shared secret';
  const type = key.key.asymmetricKeyType ?? 'unknown';
  const curve = key.key.asymmetricKeyDetails?.namedCurve ?? '';
  const name = type === 'ec' ? `EC ${CURVE_NAMES[curve] ?? curve}` : type === 'rsa' || type === 'rsa-pss' ? 'RSA' : (CURVE_NAMES[type] ?? type);
  return `an ${name} key`;
}

/** Why the key cannot check this algorithm, or null when it can. Refusing a public key for HS* stops the classic algorithm confusion. */
function mismatch(alg: string, spec: Algorithm, key: Key): string | null {
  if (spec.family === 'hmac') return key.kind === 'secret' ? null : `${alg} is signed with a shared secret, but the key is ${keyName(key)}`;
  if (key.kind === 'secret') {
    return `${alg} needs the issuer's public key: a PEM (plain or base64-wrapped), a base64 key, a certificate, a JWK or a JWK set. The text given is none of those, so it was read as a shared secret`;
  }
  const type = key.key.asymmetricKeyType;
  const ok =
    spec.family === 'rsa'
      ? type === 'rsa'
      : spec.family === 'pss'
        ? type === 'rsa' || type === 'rsa-pss'
        : spec.family === 'ec'
          ? type === 'ec' && key.key.asymmetricKeyDetails?.namedCurve === spec.curve
          : (type === 'ed25519' || type === 'ed448') && (!spec.curve || type === spec.curve);
  if (ok) return null;
  const wanted = spec.family === 'rsa' || spec.family === 'pss' ? 'an RSA key' : spec.family === 'ec' ? `an EC ${CURVE_NAMES[spec.curve!]} key` : spec.curve ? `an ${CURVE_NAMES[spec.curve]} key` : 'an Ed25519 or Ed448 key';
  return `${alg} needs ${wanted}, but the key is ${keyName(key)}`;
}

function signatureMatches(spec: Algorithm, key: Key, data: Buffer, signature: Buffer): boolean {
  try {
    if (key.kind === 'secret') {
      const expected = createHmac(spec.hash!, key.secret).update(data).digest();
      return expected.length === signature.length && timingSafeEqual(expected, signature);
    }
    switch (spec.family) {
      case 'rsa':
        return verify(spec.hash, data, { key: key.key, padding: constants.RSA_PKCS1_PADDING }, signature);
      case 'pss':
        return verify(spec.hash, data, { key: key.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      case 'ec':
        return verify(spec.hash, data, { key: key.key, dsaEncoding: 'ieee-p1363' }, signature);
      default:
        return verify(null, data, key.key, signature);
    }
  } catch {
    // A signature of the wrong length or shape does not match.
    return false;
  }
}

/**
 * Validates a JWT the way a server does: the signature, then exp and nbf (with `clockSkewSeconds`
 * of leeway), then `iss` when `issuer` is given. The key is an HMAC secret (raw, or base64 with
 * `base64Secret`), a public key, private key or certificate (PEM, base64-wrapped PEM or bare base64
 * DER), a JWK, or a JWK set (the entry with the token's `kid`, or each one in turn when the token
 * has none). Throws for a token or key it cannot check; a token that fails a check comes back with
 * `valid: false` and the reasons in `problems`.
 */
export function verifyJwt(token: string, keyText: string, options: JwtVerifyOptions = {}): JwtVerification {
  const parts = jwtParts(token);
  const header = decodePart(parts[0], 'header');
  const payload = decodePart(parts[1], 'payload');
  const alg = typeof header.alg === 'string' ? header.alg : '';
  if (alg.toLowerCase() === 'none') throw invalid('The token is unsigned (alg "none"), so there is no signature to verify');
  const spec = ALGORITHMS[alg];
  if (!spec) throw invalid(`Unsupported algorithm "${alg}". Supported: ${JWT_ALGORITHMS.join(', ')}`);

  const keys = readKeys(keyText, options.base64Secret ?? false);
  const kid = typeof header.kid === 'string' ? header.kid : null;
  const fromSet = keys.every((k) => k.format === 'JWK set');
  const candidates = kid && fromSet ? keys.filter((k) => k.kid === kid) : keys;
  if (!candidates.length) throw invalid(kid ? `No key in the JWK set has kid "${kid}"` : 'The JWK set has no keys');
  const usable = candidates.filter((k) => mismatch(alg, spec, k) === null);
  if (!usable.length) throw invalid(mismatch(alg, spec, candidates[0])!);

  const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  const signature = Buffer.from(parts[2], 'base64url');
  const match = usable.find((k) => signatureMatches(spec, k, data, signature));
  const checked = match ?? usable[0];
  const problems = [...(match ? [] : ['the signature does not match the key']), ...claimProblems(payload, options)];
  return { valid: problems.length === 0, problems, algorithm: alg, signatureValid: Boolean(match), keyFormat: checked.format, kid: checked.kid };
}
