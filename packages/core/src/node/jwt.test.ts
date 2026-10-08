import { constants, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JWT_ALGORITHMS, verifyJwt } from './jwt';

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(header: Record<string, unknown>, signer: (data: Buffer) => Buffer, payload: Record<string, unknown> = { sub: 'ada' }): string {
  const data = `${segment(header)}.${segment(payload)}`;
  return `${data}.${signer(Buffer.from(data)).toString('base64url')}`;
}

const hmac = (hash: string, secret: string | Buffer) => (data: Buffer) => createHmac(hash, secret).update(data).digest();
const pem = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

// A self-signed P-256 certificate and a token signed with its key (the key itself is not kept).
const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBhDCCASmgAwIBAgIUZlVbMKDoo8Xk9dgmxsYXtKtepHgwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLcXVpdmVyIHRlc3QwIBcNMjYxMDA4MTAyMDM5WhgPMjEyNjA5
MTQxMDIwMzlaMBYxFDASBgNVBAMMC3F1aXZlciB0ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEuOMOpO2eVVKTO1HsqtHS36Jy2RC9rNZ3k+sfaZTs6l2yLBfl
VmGzzMMkhdNlkRfFjs/DCFKpAqpOjSBjIAdL1aNTMFEwHQYDVR0OBBYEFIj3xwWJ
rb7ClCNgP1FqaWQcxaePMB8GA1UdIwQYMBaAFIj3xwWJrb7ClCNgP1FqaWQcxaeP
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAO/0f0MhARyK4x6d
34ImTkdbBa5JGJ5a+owztPUbzQTIAiEAgLZDPxfLBW5w6sZl9C6gh2AdubbKGa8f
GoeedvQgOAY=
-----END CERTIFICATE-----`;
const CERTIFICATE_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjZXJ0LXVzZXIifQ.wGnwkyec4c_KjhRA_rxGc9BPm1MGNBeRGrD-Aa5LNvQQ2K5VH_Glfv1LrmTwBC1rk1Nv7oSvPMNwgIDTBazajQ';

describe('verifyJwt', () => {
  it('checks HMAC tokens with the secret, raw or base64', () => {
    for (const [alg, hash] of [['HS256', 'sha256'], ['HS384', 'sha384'], ['HS512', 'sha512']]) {
      const signed = token({ alg }, hmac(hash, 'shh'));
      expect(verifyJwt(signed, 'shh')).toEqual({ valid: true, problems: [], algorithm: alg, signatureValid: true, keyFormat: 'secret', kid: null });
      expect(verifyJwt(signed, 'nope').signatureValid).toBe(false);
    }
    const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const signed = token({ alg: 'HS256' }, hmac('sha256', binary));
    expect(verifyJwt(signed, binary.toString('base64'), { base64Secret: true }).signatureValid).toBe(true);
    expect(verifyJwt(signed, binary.toString('base64')).signatureValid).toBe(false);
  });

  it('checks RS and PS tokens with an RSA public key', () => {
    for (const bits of ['256', '384', '512']) {
      const rs = token({ alg: `RS${bits}` }, (data) => sign(`sha${bits}`, data, rsa.privateKey));
      const ps = token({ alg: `PS${bits}` }, (data) => sign(`sha${bits}`, data, { key: rsa.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }));
      expect(verifyJwt(rs, pem(rsa.publicKey))).toMatchObject({ algorithm: `RS${bits}`, signatureValid: true, keyFormat: 'PEM' });
      expect(verifyJwt(ps, pem(rsa.publicKey))).toMatchObject({ algorithm: `PS${bits}`, signatureValid: true });
      expect(verifyJwt(rs, pem(otherRsa.publicKey)).signatureValid).toBe(false);
    }
    // PKCS#1 "RSA PUBLIC KEY" and a private key both work.
    const rs = token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey));
    expect(verifyJwt(rs, rsa.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString()).signatureValid).toBe(true);
    expect(verifyJwt(rs, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).signatureValid).toBe(true);
  });

  it('checks ES tokens on their curve and EdDSA tokens', () => {
    for (const [alg, hash, namedCurve] of [['ES256', 'sha256', 'P-256'], ['ES384', 'sha384', 'P-384'], ['ES512', 'sha512', 'P-521'], ['ES256K', 'sha256', 'secp256k1']]) {
      const pair = generateKeyPairSync('ec', { namedCurve });
      const signed = token({ alg }, (data) => sign(hash, data, { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }));
      expect(verifyJwt(signed, pem(pair.publicKey)).signatureValid).toBe(true);
    }
    for (const [type, named] of [['ed25519', 'Ed25519'], ['ed448', 'Ed448']] as const) {
      const pair = generateKeyPairSync(type as 'ed25519');
      for (const alg of ['EdDSA', named]) {
        const signed = token({ alg }, (data) => sign(null, data, pair.privateKey));
        expect(verifyJwt(signed, pem(pair.publicKey)).signatureValid).toBe(true);
      }
    }
    const ed448 = generateKeyPairSync('ed448');
    expect(() => verifyJwt(token({ alg: 'Ed25519' }, () => Buffer.alloc(64)), pem(ed448.publicKey))).toThrow('Ed25519 needs an Ed25519 key, but the key is an Ed448 key');
  });

  it('reads certificates, JWKs and JWK sets', () => {
    expect(verifyJwt(CERTIFICATE_TOKEN, CERTIFICATE)).toEqual({ valid: true, problems: [], algorithm: 'ES256', signatureValid: true, keyFormat: 'certificate', kid: null });

    const rs = token({ alg: 'RS256', kid: 'two' }, (data) => sign('sha256', data, rsa.privateKey));
    const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'two' };
    const other = { ...otherRsa.publicKey.export({ format: 'jwk' }), kid: 'one' };
    expect(verifyJwt(rs, JSON.stringify(jwk))).toEqual({ valid: true, problems: [], algorithm: 'RS256', signatureValid: true, keyFormat: 'JWK', kid: 'two' });
    expect(verifyJwt(rs, JSON.stringify({ keys: [other, jwk] }))).toEqual({ valid: true, problems: [], algorithm: 'RS256', signatureValid: true, keyFormat: 'JWK set', kid: 'two' });
    expect(() => verifyJwt(rs, JSON.stringify({ keys: [other] }))).toThrow('No key in the JWK set has kid "two"');

    // Without a kid every key of the set is tried.
    const noKid = token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey));
    expect(verifyJwt(noKid, JSON.stringify({ keys: [other, jwk] }))).toMatchObject({ signatureValid: true, kid: 'two' });

    // An "oct" JWK is an HMAC secret.
    const hs = token({ alg: 'HS256' }, hmac('sha256', 'shh'));
    expect(verifyJwt(hs, JSON.stringify({ kty: 'oct', k: Buffer.from('shh').toString('base64url') }))).toMatchObject({ signatureValid: true, keyFormat: 'JWK' });
  });

  it('reads a key by its bytes, whatever its PEM label, with or without the PEM lines', () => {
    const rs = token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey));
    const spki = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pkcs1 = rsa.publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
    const certificate = CERTIFICATE.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const asPublicKey = (body: string) => `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`;

    // Keycloak's realm public key, and a JWK's x5c entry.
    expect(verifyJwt(rs, spki)).toMatchObject({ signatureValid: true, keyFormat: 'base64 key' });
    expect(verifyJwt(CERTIFICATE_TOKEN, certificate)).toMatchObject({ signatureValid: true, keyFormat: 'certificate' });
    // Those two wrapped under the wrong label.
    expect(verifyJwt(rs, asPublicKey(pkcs1))).toMatchObject({ signatureValid: true, keyFormat: 'PEM' });
    expect(verifyJwt(CERTIFICATE_TOKEN, asPublicKey(certificate))).toMatchObject({ signatureValid: true, keyFormat: 'certificate' });
    // A PEM copied out of a JSON or .env value, and one squashed onto a line.
    expect(verifyJwt(rs, pem(rsa.publicKey).trim().replace(/\n/g, '\\n')).signatureValid).toBe(true);
    expect(verifyJwt(rs, pem(rsa.publicKey).trim().replace(/\n/g, ' ')).signatureValid).toBe(true);
    // A private key gives its public half.
    expect(verifyJwt(rs, rsa.privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64')).signatureValid).toBe(true);

    // Text that only looks like base64 is still a secret.
    const hs = token({ alg: 'HS256' }, hmac('sha256', 'MySecret'));
    expect(verifyJwt(hs, 'MySecret')).toMatchObject({ signatureValid: true, keyFormat: 'secret' });
  });

  it('reports a tampered payload as an invalid signature', () => {
    const signed = token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey));
    const [header, , signature] = signed.split('.');
    expect(verifyJwt(`${header}.${segment({ sub: 'mallory' })}.${signature}`, pem(rsa.publicKey))).toMatchObject({
      valid: false,
      signatureValid: false,
      problems: ['the signature does not match the key'],
    });
  });

  it('takes the token alone or as an Authorization header value', () => {
    const signed = token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey));
    for (const pasted of [`Bearer ${signed}`, `jwt ${signed}`, `  JWT   ${signed}  `, `Authorization: jwt ${signed}`, `authorization: Bearer ${signed}`]) {
      expect(verifyJwt(pasted, pem(rsa.publicKey)).valid).toBe(true);
    }
  });

  it('checks expiry, not-before and the issuer like a server', () => {
    const now = Date.UTC(2026, 9, 8, 12, 0, 0);
    const at = (seconds: number) => Math.floor(now / 1000) + seconds;
    const signedWith = (payload: Record<string, unknown>) => token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey), payload);
    const key = pem(rsa.publicKey);

    const live = signedWith({ iss: 'authservice', nbf: at(-60), exp: at(300) });
    expect(verifyJwt(live, key, { now, issuer: 'authservice' })).toMatchObject({ valid: true, problems: [] });
    expect(verifyJwt(live, key, { now, issuer: 'other' })).toMatchObject({ valid: false, signatureValid: true, problems: ['issuer is "authservice", expected "other"'] });
    expect(verifyJwt(signedWith({}), key, { now, issuer: 'authservice' }).problems).toEqual(['no issuer, expected "authservice"']);

    const expired = signedWith({ exp: at(-10) });
    expect(verifyJwt(expired, key, { now })).toMatchObject({ valid: false, signatureValid: true, problems: ['expired 10 seconds ago (2026-10-08T11:59:50.000Z)'] });
    expect(verifyJwt(expired, key, { now, clockSkewSeconds: 30 }).valid).toBe(true);
    expect(verifyJwt(signedWith({ exp: at(0) }), key, { now }).valid).toBe(false);

    const early = signedWith({ nbf: at(120) });
    expect(verifyJwt(early, key, { now }).problems).toEqual(['not valid until 2026-10-08T12:02:00.000Z (2 minutes from now)']);
    expect(verifyJwt(early, key, { now, clockSkewSeconds: 120 }).valid).toBe(true);
  });

  // A common auth-server contract: RS256 signed by the auth server, checked against JWT_RSA_PUBLIC_KEY,
  // which is the SubjectPublicKeyInfo PEM base64-encoded once more, sent as "Authorization: jwt <token>".
  it('validates an auth-server token against its base64-wrapped public key', () => {
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    const authToken = token({ alg: 'RS256', typ: 'JWT' }, (data) => sign('sha256', data, rsa.privateKey), {
      sub: 'auth',
      iss: 'authservice',
      iat: seconds,
      nbf: seconds - 60,
      exp: seconds + 300,
      data: { user: { id: 27768, name: 'Alice', permissions: ['omstwoapi:checkout:wallet'] } },
    });
    const wrapped = Buffer.from(pem(rsa.publicKey)).toString('base64');
    expect(wrapped.startsWith('LS0tLS1CRUdJTiBQVUJMSUMg')).toBe(true);
    const pasted = `  ${wrapped.slice(0, 64)}\r\n${wrapped.slice(64)}\n`;

    expect(verifyJwt(`jwt ${authToken}`, pasted, { issuer: 'authservice', clockSkewSeconds: 30 })).toEqual({
      valid: true,
      problems: [],
      algorithm: 'RS256',
      signatureValid: true,
      keyFormat: 'base64 PEM',
      kid: null,
    });
    const otherWrapped = Buffer.from(pem(otherRsa.publicKey)).toString('base64');
    expect(verifyJwt(authToken, otherWrapped)).toMatchObject({ valid: false, signatureValid: false });
    // Base64 that does not hold a PEM stays a secret, so RS256 refuses it.
    expect(() => verifyJwt(authToken, Buffer.from('not a pem').toString('base64'))).toThrow("RS256 needs the issuer's public key");
  });

  it('refuses keys that do not fit the algorithm', () => {
    // A public key used as an HMAC secret is the algorithm confusion attack.
    const confused = token({ alg: 'HS256' }, hmac('sha256', pem(rsa.publicKey)));
    expect(() => verifyJwt(confused, pem(rsa.publicKey))).toThrow('HS256 is signed with a shared secret, but the key is an RSA key');
    const rs = token({ alg: 'RS256' }, (data) => sign('sha256', data, rsa.privateKey));
    expect(() => verifyJwt(rs, 'shh')).toThrow("RS256 needs the issuer's public key: a PEM (plain or base64-wrapped), a base64 key, a certificate, a JWK or a JWK set. The text given is none of those");
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    expect(() => verifyJwt(token({ alg: 'ES256' }, () => Buffer.alloc(64)), pem(p384.publicKey))).toThrow('ES256 needs an EC P-256 key, but the key is an EC P-384 key');
  });

  it('refuses tokens and keys it cannot check', () => {
    expect(() => verifyJwt('a.b', 'shh')).toThrow('three dot-separated parts');
    expect(() => verifyJwt(token({ alg: 'none' }, () => Buffer.alloc(0)), 'shh')).toThrow('unsigned');
    expect(() => verifyJwt(token({ alg: 'XS256' }, () => Buffer.alloc(0)), 'shh')).toThrow(`Supported: ${JWT_ALGORITHMS.join(', ')}`);
    expect(() => verifyJwt(token({ alg: 'HS256' }, hmac('sha256', 'x')), '  ')).toThrow('Give a secret or a public key');
    expect(() => verifyJwt(token({ alg: 'RS256' }, () => Buffer.alloc(0)), '-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----')).toThrow('Cannot read the PEM key');
    expect(() => verifyJwt(token({ alg: 'RS256' }, () => Buffer.alloc(0)), '{"kty": "RSA"')).toThrow('not valid JSON');
  });
});
