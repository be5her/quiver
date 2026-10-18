# Smoke test certificates

Test-only TLS material for the smoke's mutual-TLS server (`fixtures.ts`), valid for 100 years: a CA (`ca.crt`; its key was deleted after signing), a server certificate for 127.0.0.1 and localhost, and a client certificate as PEM and as PKCS#12 (`client.p12`, passphrase `smoke-pass`). They protect nothing and must never be trusted outside the smoke.
