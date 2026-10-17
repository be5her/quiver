import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { QuiverError, authorizeUrl, oauthIdentity, parseTokenResponse, readCallback, tokenIsFresh, tokenRequest, type HostApi, type OAuth2Auth, type OAuthToken, type WorkspaceApi } from '@quiver/core';
import { fetch as undiciFetch } from 'undici';

/** Tokens per machine, under `.quiver/local`, each encrypted with the OS keychain. */
export const OAUTH_TOKENS_DOC = 'oauth-tokens';
type TokensDoc = Record<string, string>;

export type TokenSource = 'cache' | 'refresh' | 'new';

export interface TokenResult {
  token: OAuthToken;
  source: TokenSource;
}

/** The key a token is cached under: a hash of what identifies it (grant, token URL, client, scopes, audience). */
export function tokenKey(auth: OAuth2Auth): string {
  return createHash('sha256').update(oauthIdentity(auth)).digest('hex').slice(0, 24);
}

/** The browser session a sign-in uses, so a second sign-in can reuse the provider's own session. */
function partitionFor(key: string): string {
  return `persist:quiver-oauth-${key}`;
}

export async function readToken(w: WorkspaceApi, host: HostApi, key: string): Promise<OAuthToken | null> {
  const doc = await w.store.readLocal<TokensDoc>(OAUTH_TOKENS_DOC, {});
  const cipher = doc[key];
  if (!cipher) return null;
  try {
    return JSON.parse(host.secrets.decrypt(cipher)) as OAuthToken;
  } catch {
    return null;
  }
}

async function writeToken(w: WorkspaceApi, host: HostApi, key: string, token: OAuthToken | null): Promise<void> {
  const doc = await w.store.readLocal<TokensDoc>(OAUTH_TOKENS_DOC, {});
  if (token) doc[key] = host.secrets.encrypt(JSON.stringify(token));
  else delete doc[key];
  await w.store.writeLocal(OAUTH_TOKENS_DOC, doc);
  // writeLocal does not announce itself; the auth editors show the token's state.
  host.emit('store.changed', { workspaceId: w.id, collection: OAUTH_TOKENS_DOC });
}

function check(auth: OAuth2Auth): void {
  if (!auth.tokenUrl.trim()) throw new QuiverError('INVALID_INPUT', 'OAuth 2.0 needs the token URL');
  if (!auth.clientId.trim()) throw new QuiverError('INVALID_INPUT', 'OAuth 2.0 needs the client ID');
  if (auth.grant === 'authorization_code' && !auth.authUrl?.trim()) throw new QuiverError('INVALID_INPUT', 'The authorization code grant needs the authorize URL');
}

async function postToken(auth: OAuth2Auth, grant: Record<string, string>): Promise<OAuthToken> {
  const { body, headers } = tokenRequest(auth, grant);
  const url = auth.tokenUrl.trim();
  let status: number;
  let text: string;
  try {
    const res = await undiciFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
    status = res.status;
    text = await res.text();
  } catch (err) {
    const cause = (err as { cause?: Error }).cause;
    throw new QuiverError('REQUEST_FAILED', `Could not reach the token URL ${url}: ${cause?.message ?? (err as Error).message}`);
  }
  try {
    return parseTokenResponse(status, text, Date.now());
  } catch (err) {
    throw new QuiverError('REQUEST_FAILED', (err as Error).message, { status });
  }
}

function scopeAndAudience(auth: OAuth2Auth): Record<string, string> {
  return {
    ...(auth.scopes.trim() ? { scope: auth.scopes.trim() } : {}),
    ...(auth.audience?.trim() ? { audience: auth.audience.trim() } : {}),
  };
}

/**
 * A sign-in in a Quiver window: a loopback listener on 127.0.0.1 takes the redirect, the window opens
 * the authorize page and closes when the redirect lands; PKCE (S256) unless turned off.
 */
async function signInForCode(host: HostApi, auth: OAuth2Auth, key: string): Promise<{ code: string; redirectUri: string; verifier?: string }> {
  const web = host.web;
  if (!web) throw new QuiverError('SIGN_IN_REQUIRED', 'This Quiver has no window to sign in with');
  const state = randomBytes(16).toString('base64url');
  const verifier = auth.pkce ? randomBytes(32).toString('base64url') : undefined;
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : undefined;
  let received: string | null = null;
  let port = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    received = `http://127.0.0.1:${port}${req.url ?? ''}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Signed in</title><p style="font:15px system-ui;margin:3em">Signed in. You can close this window and go back to Quiver.</p>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(new QuiverError('INVALID_INPUT', err.code === 'EADDRINUSE' ? `The callback port ${auth.callbackPort} is in use; free it or pick another` : `Could not listen for the sign-in: ${err.message}`)),
    );
    server.listen(auth.callbackPort ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    let landed: string | null = null;
    const ok = await web.signIn({
      partition: partitionFor(key),
      url: authorizeUrl(auth, { redirectUri, state, codeChallenge: challenge }),
      title: 'Sign in for Quiver',
      done: (url) => {
        if (!url.startsWith(redirectUri)) return false;
        landed = url;
        return true;
      },
    });
    if (!ok) throw new QuiverError('INVALID_INPUT', 'The sign-in window was closed before the sign-in finished');
    const result = readCallback(received ?? landed ?? '', state);
    if ('error' in result) throw new QuiverError('REQUEST_FAILED', result.error);
    return { code: result.code, redirectUri, verifier };
  } finally {
    server.close();
  }
}

/**
 * A token for this auth: the cached one while it is fresh, else a refresh with the refresh token,
 * else a new one (client credentials, or a sign-in when `interactive`). `force` skips the cache and
 * the refresh. Agents are not interactive: an authorization code token they cannot refresh is
 * SIGN_IN_REQUIRED, to be got from the Quiver window.
 */
export async function getOAuthToken(w: WorkspaceApi, host: HostApi, auth: OAuth2Auth, options: { interactive: boolean; force?: boolean }): Promise<TokenResult> {
  check(auth);
  const key = tokenKey(auth);
  const cached = options.force ? null : await readToken(w, host, key);
  if (cached && tokenIsFresh(cached, Date.now())) return { token: cached, source: 'cache' };

  if (cached?.refreshToken) {
    try {
      const refreshed = await postToken(auth, { grant_type: 'refresh_token', refresh_token: cached.refreshToken, ...(auth.scopes.trim() ? { scope: auth.scopes.trim() } : {}) });
      // A server may keep the refresh token and send none back.
      const token = refreshed.refreshToken ? refreshed : { ...refreshed, refreshToken: cached.refreshToken };
      await writeToken(w, host, key, token);
      return { token, source: 'refresh' };
    } catch {
      // A refused refresh falls through to a new token.
    }
  }

  let token: OAuthToken;
  if (auth.grant === 'client_credentials') {
    token = await postToken(auth, { grant_type: 'client_credentials', ...scopeAndAudience(auth) });
  } else {
    if (!options.interactive) {
      throw new QuiverError(
        'SIGN_IN_REQUIRED',
        `Signing in at ${new URL(auth.tokenUrl.trim()).host} needs the Quiver window: open the request's Auth segment and press Get token`,
      );
    }
    const { code, redirectUri, verifier } = await signInForCode(host, auth, key);
    token = await postToken(auth, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}) });
  }
  await writeToken(w, host, key, token);
  return { token, source: 'new' };
}

export interface OAuthStatus {
  hasToken: boolean;
  fresh: boolean;
  expiresAt: number | null;
  scope: string | null;
  refreshable: boolean;
}

/** What is cached for this auth, without asking the server. */
export async function oauthStatus(w: WorkspaceApi, host: HostApi, auth: OAuth2Auth): Promise<OAuthStatus> {
  const token = auth.tokenUrl.trim() && auth.clientId.trim() ? await readToken(w, host, tokenKey(auth)) : null;
  return {
    hasToken: Boolean(token),
    fresh: token ? tokenIsFresh(token, Date.now()) : false,
    expiresAt: token?.expiresAt ?? null,
    scope: token?.scope ?? null,
    refreshable: Boolean(token?.refreshToken),
  };
}

/** Forget the cached token and the sign-in window's session, so the next token asks again. */
export async function clearOAuthToken(w: WorkspaceApi, host: HostApi, auth: OAuth2Auth): Promise<void> {
  const key = tokenKey(auth);
  await writeToken(w, host, key, null);
  await host.web?.clear(partitionFor(key)).catch(() => undefined);
}
