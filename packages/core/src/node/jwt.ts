import { X509Certificate, constants, createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject, type webcrypto } from 'node:crypto';
import { QuiverError } from '../errors';

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
  algorithm: string;
  /** The signature matches the key. Expiry and not-before are not part of it. */
  signatureValid: boolean;
  /** How the key was read: `secret`, `PEM`, `certificate`, `JWK` or `JWK set`. */
  keyFormat: string;
  /** The `kid` of the JWK that was checked, when it has one. */
  kid: string | null;
}

type Key = { kind: 'secret'; secret: Buffer; format: string; kid: string | null } | { kind: 'public'; key: KeyObject; format: string; kid: string | null };

function invalid(message: string): QuiverError {
  return new QuiverError('INVALID_INPUT', message);
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

/** A secret, a PEM key or certificate, a JWK, or a JWK set, as the keys it holds. */
function readKeys(text: string, base64Secret: boolean): Key[] {
  const trimmed = text.trim();
  if (!trimmed) throw invalid('Give a secret or a public key to verify against');
  if (trimmed.startsWith('-----BEGIN')) {
    try {
      if (trimmed.startsWith('-----BEGIN CERTIFICATE')) return [{ kind: 'public', key: new X509Certificate(trimmed).publicKey, format: 'certificate', kid: null }];
      return [{ kind: 'public', key: createPublicKey(trimmed), format: 'PEM', kid: null }];
    } catch (err) {
      throw invalid(`Cannot read the PEM key: ${(err as Error).message}`);
    }
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
  if (key.kind === 'secret') return `${alg} needs a public key (PEM, certificate or JWK), not a shared secret`;
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
 * Checks a JWT's signature. The key is an HMAC secret (raw, or base64 with `base64Secret`), a PEM
 * public key, private key or certificate, a JWK, or a JWK set (the entry with the token's `kid`,
 * or each one in turn when the token has none). Throws for a token or key it cannot check; a
 * signature that does not match is `signatureValid: false`.
 */
export function verifyJwt(token: string, keyText: string, options: { base64Secret?: boolean } = {}): JwtVerification {
  const parts = token.trim().replace(/^bearer\s+/i, '').split('.');
  if (parts.length !== 3) throw invalid('A JWT has three dot-separated parts');
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw invalid('The JWT header is not base64url-encoded JSON');
  }
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
  return { algorithm: alg, signatureValid: Boolean(match), keyFormat: checked.format, kid: checked.kid };
}
