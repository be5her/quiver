# Tools

Small converters that need no workspace: JSON format (pretty-print with a chosen indent, sort keys, or minify), JWT (header, payload and expiry, and the signature checked against a key), base64 encode and decode (standard or URL-safe), URL encode and decode, hash, UUID and timestamp. Each opens in its own tab from the sidebar or the command palette; most run on every keystroke.

## How it works

Every tool is a global command (`tools.json.format`, `tools.json.minify`, `tools.jwt.decode`, `tools.jwt.verify`, `tools.base64.encode`, `tools.base64.decode`, `tools.url.encode`, `tools.url.decode`, `tools.hash.digest`, `tools.uuid.generate`, `tools.timestamp.convert`) with a zod schema, so the same conversions are available from the palette and to agents. Nothing is stored.

The JWT tab decodes the token as it is pasted. Put a key in "Verify the signature with" and it runs `tools.jwt.verify` instead, which says above the output whether the signature matches. The key can be the shared secret for HS256, HS384 and HS512 (tick "Secret is base64" when it is stored that way), or a public key, private key or certificate for RS, PS, ES (P-256, P-384, P-521, secp256k1) and EdDSA (Ed25519, Ed448): as PEM, as bare base64 (Keycloak's realm public key, a JWK's `x5c` entry), as a JWK, or as a JWK set, matched on the token's `kid` or tried key by key when it has none. A key is read by its bytes rather than its PEM label, so a certificate or a PKCS#1 key pasted under "BEGIN PUBLIC KEY" works, and so does a PEM copied out of a JSON or .env value with its line breaks written as `\n`. `signatureValid` is about the signature only: expiry stays in `isExpired`. A key that cannot check the token's algorithm is refused rather than reported as a mismatch, including a public key offered for an HS token (the algorithm confusion attack), and so is `alg: none`. The checks run on Node's crypto (`verifyJwt` in `@quiver/core/node`), with no dependency.

## Agents

Every tool is a pure conversion of its input and is allowed, `tools_jwt_verify` included.

## Verified by

Unit tests sign tokens for every supported algorithm and check them against the right key, a wrong key, a tampered payload, a certificate, a JWK and a JWK set, read keys under the wrong PEM label or none, and expect mismatched keys, `alg: none` and unreadable keys to be refused. The smoke verifies the jwt.io sample token against its secret and a wrong one, expects an agent offering a public key for it to be refused, and in the UI pastes the token and a secret into the JWT tab and reads the verdict.
