import { generateKeyPairSync, sign } from 'node:crypto';
import type { SmokeSection } from '../../part';

// Tools: the tool list over MCP, JWT decode and verify, and the JWT tab.
const section: SmokeSection = async (t) => {
  const { host, check, run, toolNames: names } = t;

  check('mcp lists the small tools', ['tools_json_format', 'tools_jwt_decode', 'tools_jwt_verify'].every((n) => names.includes(n)), names.filter((n) => n.startsWith('tools_')));

  const jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const jwt = await run<{ payload: { sub: string } }>('tools.jwt.decode', { token: jwtToken }, null);
  check('tools.jwt.decode', jwt.payload.sub === '1234567890');
  {
    type Verified = { signatureValid: boolean; algorithm: string; keyFormat: string; payload: { sub: string } };
    const verified = await run<Verified>('tools.jwt.verify', { token: jwtToken, key: 'your-256-bit-secret' }, null);
    const forged = await run<Verified>('tools.jwt.verify', { token: jwtToken, key: 'not-the-secret' }, null);
    const publicPem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const confused = await host.invoke('tools.jwt.verify', { token: jwtToken, key: publicPem }, { caller: 'mcp', workspaceId: null });
    check(
      'tools.jwt.verify: the secret verifies, another does not, a public key is refused for HS256',
      verified.signatureValid && verified.algorithm === 'HS256' && verified.keyFormat === 'secret' && verified.payload.sub === '1234567890' && !forged.signatureValid && !confused.ok && /shared secret/.test(confused.error.message),
      { verified, forged, confused },
    );
    // Electron's BoringSSL reads the key: bare base64 (Keycloak's realm key) and a PKCS#1 key under the "PUBLIC KEY" label both verify.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const data = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from('{"sub":"ada"}').toString('base64url')}`;
    const rsToken = `${data}.${sign('sha256', Buffer.from(data), rsa.privateKey).toString('base64url')}`;
    const der = (type: 'spki' | 'pkcs1') => rsa.publicKey.export({ type, format: 'der' }).toString('base64');
    const bare = await run<Verified>('tools.jwt.verify', { token: rsToken, key: der('spki') }, null);
    const mislabelled = await run<Verified>('tools.jwt.verify', { token: rsToken, key: `-----BEGIN PUBLIC KEY-----\n${der('pkcs1')}\n-----END PUBLIC KEY-----` }, null);
    check(
      'tools.jwt.verify: a bare base64 key and a PKCS#1 key labelled PUBLIC KEY verify RS256',
      bare.signatureValid && bare.keyFormat === 'base64 key' && mislabelled.signatureValid && mislabelled.keyFormat === 'PEM',
      { bare, mislabelled },
    );
  }
  // An auth server's token as an API behind it receives it: RS256, "Authorization: jwt <token>", checked against
  // JWT_RSA_PUBLIC_KEY (the public key PEM base64-encoded once more), issuer pinned, 30 s clock skew. It expires five
  // minutes after it is minted, so the UI phase mints its own: on a full run it starts minutes after this one.
  const mintAuthServerToken = () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub: 'auth', iss: 'authservice', iat: now, nbf: now - 60, exp: now + 300, data: { user: { id: 27768, name: 'Alice' } } })}`;
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    return { token: `${data}.${sign('sha256', Buffer.from(data), pair.privateKey).toString('base64url')}`, key: Buffer.from(pem).toString('base64') };
  };
  {
    const authServer = mintAuthServerToken();
    type Validated = { valid: boolean; problems: string[]; keyFormat: string; signatureValid: boolean };
    const accepted = await run<Validated>('tools.jwt.verify', { token: `jwt ${authServer.token}`, key: authServer.key, issuer: 'authservice', clockSkewSeconds: 30 }, null);
    const otherIssuer = await run<Validated>('tools.jwt.verify', { token: authServer.token, key: authServer.key, issuer: 'someone-else' }, null);
    const audienceAsked = await run<Validated>('tools.jwt.verify', { token: authServer.token, key: authServer.key, audience: 'checkout' }, null);
    check(
      'tools.jwt.verify: an auth-server token is valid against its base64-wrapped public key, and invalid for another issuer or a required audience',
      accepted.valid &&
        accepted.keyFormat === 'base64 PEM' &&
        !otherIssuer.valid &&
        otherIssuer.signatureValid &&
        otherIssuer.problems.join() === 'issuer is "authservice", expected "someone-else"' &&
        !audienceAsked.valid &&
        audienceAsked.problems.join() === 'no audience, expected "checkout"',
      { accepted, otherIssuer, audienceAsked },
    );
  }

  return {
    ui: async (u) => {
      const { js, wait, shot } = u;
      await js(`document.documentElement.classList.add('dark')`);
      // Tools: the JWT tab decodes the token as it is pasted and verifies it once a key is given.
      {
        const clickedTools = await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Tools'); if (btn) btn.click(); return Boolean(btn); })()`);
        await wait(300);
        await js(`(() => { const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.includes('verify its signature')); if (btn) btn.click(); })()`);
        await wait(500);
        const pane = `[...document.querySelectorAll('[data-tab-type="tools.tool"]')].find((el) => !el.classList.contains('hidden'))`;
        const typeInto = (editor: string, text: string, replace = false) =>
          js(
            `(() => { const c = ${pane}?.querySelector('${editor} .cm-content'); if (!c) return false; c.focus(); ${replace ? "document.execCommand('selectAll');" : ''} document.execCommand('insertText', false, ${JSON.stringify(text)}); return true; })()`,
          );
        const summary = () => js(`${pane}?.querySelector('[data-testid=tool-summary]')?.textContent.trim() ?? null`);
        const typedToken = await typeInto(':scope', jwtToken);
        await wait(500);
        const decoded = { output: await js(`[...(${pane}?.querySelectorAll('.cm-content') ?? [])].at(-1)?.textContent ?? ''`), summary: await summary() };
        await typeInto('[data-testid=tool-second-input]', 'your-256-bit-secret');
        await wait(500);
        const verified = await summary();
        await shot('08b-jwt-verify-dark');
        await typeInto('[data-testid=tool-second-input]', '!');
        await wait(500);
        const mismatched = await summary();
        check(
          'ui: the JWT tab decodes the token, then verifies it once a secret is given',
          clickedTools === true &&
            typedToken === true &&
            typeof decoded.output === 'string' &&
            decoded.output.includes('1234567890') &&
            decoded.summary === null &&
            verified === 'Valid: signature verified (HS256, secret)' &&
            mismatched === 'Invalid (HS256, secret): the signature does not match the key',
          { decoded, verified, mismatched },
        );
        // The auth-server case: "jwt <token>" pasted with the base64-wrapped public key and the issuer pinned.
        const authServer = mintAuthServerToken();
        await typeInto(':scope', `jwt ${authServer.token}`, true);
        await typeInto('[data-testid=tool-second-input]', authServer.key, true);
        const setOption = (key: string, value: string) =>
          js(`(() => { const el = ${pane}?.querySelector('[data-testid=tool-option-${key}]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await setOption('issuer', 'authservice');
        await wait(600);
        const authValid = await summary();
        await shot('08c-jwt-auth-server-dark');
        await setOption('issuer', 'someone-else');
        await wait(600);
        const authWrongIssuer = await summary();
        await setOption('issuer', 'authservice');
        await setOption('audience', 'checkout');
        await wait(600);
        const authNoAudience = await summary();
        check(
          'ui: the JWT tab validates an auth-server token against its base64-wrapped key, pinned issuer and audience',
          // Freshly minted with five minutes left, read a second or two later: it rounds to 5 (4 if the UI stalled).
          typeof authValid === 'string' &&
            /^Valid: signature verified \(RS256, base64 PEM\), expires [45] minutes from now$/.test(authValid) &&
            authWrongIssuer === 'Invalid (RS256, base64 PEM): issuer is "authservice", expected "someone-else"' &&
            authNoAudience === 'Invalid (RS256, base64 PEM): no audience, expected "checkout"',
          { authValid, authWrongIssuer, authNoAudience },
        );
        await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
        await wait(200);
      }
    },
  };
};

export default section;
