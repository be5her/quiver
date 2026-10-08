# Tools

Small converters that need no workspace: JSON format (pretty-print with a chosen indent, sort keys, or minify), JWT (header, payload and expiry, and the signature checked against a key), base64 encode and decode (standard or URL-safe), URL encode and decode, hash, UUID and timestamp. Each opens in its own tab from the sidebar or the command palette; most run on every keystroke.

## How it works

Every tool is a global command (`tools.json.format`, `tools.json.minify`, `tools.jwt.decode`, `tools.jwt.verify`, `tools.base64.encode`, `tools.base64.decode`, `tools.url.encode`, `tools.url.decode`, `tools.hash.digest`, `tools.uuid.generate`, `tools.timestamp.convert`) with a zod schema, so the same conversions are available from the palette and to agents. Nothing is stored.

The JWT tab decodes the token as it is pasted. Put a key in "Verify the signature with" and it runs `tools.jwt.verify` instead, which says above the output whether the signature matches. The key can be the shared secret for HS256, HS384 and HS512 (tick "Secret is base64" when it is stored that way), or a PEM public key, private key or certificate, a JWK, or a JWK set for RS, PS, ES (P-256, P-384, P-521, secp256k1) and EdDSA (Ed25519, Ed448); a JWK set is matched on the token's `kid`, or each key is tried when it has none. `signatureValid` is about the signature only: expiry stays in `isExpired`. A key that cannot check the token's algorithm is refused rather than reported as a mismatch, including a public key offered for an HS token (the algorithm confusion attack), and so is `alg: none`. The checks run on Node's crypto (`verifyJwt` in `@quiver/core/node`), with no dependency.

## Agents

Every tool is a pure conversion of its input and is allowed, `tools_jwt_verify` included.

## Verified by

Unit tests sign tokens for every supported algorithm and check them against the right key, a wrong key, a tampered payload, a certificate, a JWK and a JWK set, and expect mismatched keys, `alg: none` and unreadable keys to be refused. The smoke verifies the jwt.io sample token against its secret and a wrong one, expects an agent offering a public key for it to be refused, and in the UI pastes the token and a secret into the JWT tab and reads the verdict.
