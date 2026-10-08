# Tools

Small converters that need no workspace: JSON format (pretty-print with a chosen indent, sort keys, or minify), JWT (header, payload and expiry, and validated against a key the way a server does), base64 encode and decode (standard or URL-safe), URL encode and decode, hash, UUID and timestamp. Each opens in its own tab from the sidebar or the command palette; most run on every keystroke.

## How it works

Every tool is a global command (`tools.json.format`, `tools.json.minify`, `tools.jwt.decode`, `tools.jwt.verify`, `tools.base64.encode`, `tools.base64.decode`, `tools.url.encode`, `tools.url.decode`, `tools.hash.digest`, `tools.uuid.generate`, `tools.timestamp.convert`) with a zod schema, so the same conversions are available from the palette and to agents. Nothing is stored.

The JWT tab decodes the token as it is pasted, on its own or as an Authorization header value (`Bearer <token>`, the `jwt <token>` scheme some APIs use, or the whole `Authorization: …` line). Put a key in "Validate with" and it runs `tools.jwt.verify` instead, which validates the token as a server would and says above the output whether it is valid, and if not, why:

- the signature, against the key;
- `exp` and `nbf`, allowing "Clock skew" seconds either way (0 by default; ASP.NET's JwtBearer allows 300, many services 30);
- `iss`, when "Issuer" is filled in.

The audience is not checked. The key can be the shared secret for HS256, HS384 and HS512 (tick "Secret is base64" when it is stored that way), or a public key, private key or certificate for RS, PS, ES (P-256, P-384, P-521, secp256k1) and EdDSA (Ed25519, Ed448): as PEM; as a base64-wrapped PEM, the form an environment variable often carries one in (`LS0tLS1CRUdJTi…`); as bare base64 DER (Keycloak's realm public key, a JWK's `x5c` entry); as a JWK; or as a JWK set, matched on the token's `kid` or tried key by key when it has none. A key is read by its bytes rather than its PEM label, so a certificate or a PKCS#1 key pasted under "BEGIN PUBLIC KEY" works, and so does a PEM copied out of a JSON or .env value with its line breaks written as `\n`. In the result, `valid` is the verdict, `problems` lists what failed, and `signatureValid` is the signature alone. A key that cannot check the token's algorithm is refused rather than reported as a mismatch, including a public key offered for an HS token (the algorithm confusion attack), and so is `alg: none`. The checks run on Node's crypto (`verifyJwt` in `@quiver/core/node`), with no dependency.

## Agents

Every tool is a pure conversion of its input and is allowed, `tools_jwt_verify` included.

## Verified by

Unit tests sign tokens for every supported algorithm and check them against the right key, a wrong key, a tampered payload, a certificate, a JWK and a JWK set, read keys under the wrong PEM label or none, check expiry, not-before and the issuer with and without clock skew, and expect mismatched keys, `alg: none` and unreadable keys to be refused. One mirrors an auth server's contract: an RS256 token sent as `jwt <token>`, checked against the base64-wrapped public key with copy-paste whitespace in it, issuer pinned. The smoke verifies the jwt.io sample token against its secret and a wrong one, expects an agent offering a public key for it to be refused, validates an auth-server token against its base64-wrapped key (and fails it for another issuer), and in the UI pastes the HS256 token with a secret, then the auth-server token with its key and issuer, into the JWT tab and reads the verdicts.
