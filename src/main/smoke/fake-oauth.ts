import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

/**
 * An OAuth 2.0 server for the smoke: a confidential client `quiver` (secret `cc-secret`) and a public
 * client `web`. The authorize page redirects back with a code at once; the token endpoint does client
 * credentials, authorization codes (checking PKCE) and refresh tokens, with `expiresIn` settable.
 */
export interface FakeOAuth {
  url: string;
  state: { expiresIn: number };
  seen: { authorize: number; clientCredentials: number; codes: number; refreshes: number; pkceOk: boolean | null; lastClientAuth: 'basic' | 'body' | null };
  close(): Promise<void>;
}

const CLIENTS: Record<string, string> = { quiver: 'cc-secret', web: '' };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

export async function startFakeOAuth(): Promise<FakeOAuth> {
  const state = { expiresIn: 3600 };
  const seen: FakeOAuth['seen'] = { authorize: 0, clientCredentials: 0, codes: 0, refreshes: 0, pkceOk: null, lastClientAuth: null };
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string | null }>();
  const refreshTokens = new Set<string>();
  let counter = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/authorize') {
      seen.authorize++;
      const clientId = url.searchParams.get('client_id') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (!(clientId in CLIENTS) || !redirectUri.startsWith('http://127.0.0.1:')) return json(400, { error: 'invalid_request' });
      const code = `code-${++counter}`;
      codes.set(code, { clientId, redirectUri, challenge: url.searchParams.get('code_challenge') });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(await readBody(req));
      let clientId = form.get('client_id') ?? '';
      let secret = form.get('client_secret') ?? '';
      seen.lastClientAuth = 'body';
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      if (basic) {
        const [id, pw] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
        const decode = (v: string) => decodeURIComponent(v.replace(/\+/g, ' '));
        clientId = decode(id ?? '');
        secret = decode(pw ?? '');
        seen.lastClientAuth = 'basic';
      }
      if (!(clientId in CLIENTS) || CLIENTS[clientId] !== secret) return json(401, { error: 'invalid_client', error_description: 'unknown client or wrong secret' });
      const grant = form.get('grant_type');
      if (grant === 'client_credentials') {
        if (!CLIENTS[clientId]) return json(400, { error: 'unauthorized_client' });
        seen.clientCredentials++;
        return json(200, { access_token: `cc-${++counter}`, token_type: 'Bearer', expires_in: state.expiresIn, scope: form.get('scope') ?? '' });
      }
      if (grant === 'authorization_code') {
        const issued = codes.get(form.get('code') ?? '');
        if (!issued || issued.clientId !== clientId || issued.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code') ?? '');
        if (issued.challenge) {
          const verifier = form.get('code_verifier') ?? '';
          seen.pkceOk = createHash('sha256').update(verifier).digest('base64url') === issued.challenge;
          if (!seen.pkceOk) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier does not match' });
        }
        seen.codes++;
        const refresh = `rt-${++counter}`;
        refreshTokens.add(refresh);
        return json(200, { access_token: `ac-${counter}`, token_type: 'Bearer', expires_in: state.expiresIn, refresh_token: refresh });
      }
      if (grant === 'refresh_token') {
        if (!refreshTokens.has(form.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
        seen.refreshes++;
        return json(200, { access_token: `rf-${++counter}`, token_type: 'Bearer', expires_in: state.expiresIn });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
