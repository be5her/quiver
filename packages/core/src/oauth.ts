import type { OAuth2Auth } from './models/api';

/** A token as Quiver keeps it. Times are epoch milliseconds. */
export interface OAuthToken {
  accessToken: string;
  tokenType: string;
  /** Null when the server gave no expiry. */
  expiresAt: number | null;
  refreshToken?: string;
  scope?: string;
  obtainedAt: number;
}

/** Use a token for this long before it expires at most; nearer than that it is refreshed or fetched again. */
export const TOKEN_EXPIRY_MARGIN_MS = 30_000;

export function tokenIsFresh(token: Pick<OAuthToken, 'expiresAt'>, now: number): boolean {
  return token.expiresAt === null || token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now;
}

/** What identifies the token an auth gets: two requests with the same of these share one. */
export function oauthIdentity(auth: Pick<OAuth2Auth, 'grant' | 'tokenUrl' | 'clientId' | 'scopes' | 'audience'>): string {
  const scopes = auth.scopes.split(/\s+/).filter(Boolean).sort().join(' ');
  return JSON.stringify([auth.grant, auth.tokenUrl.trim(), auth.clientId.trim(), scopes, auth.audience?.trim() ?? '']);
}

/** The authorize page URL for the authorization code grant. */
export function authorizeUrl(auth: Pick<OAuth2Auth, 'authUrl' | 'clientId' | 'scopes' | 'audience'>, params: { redirectUri: string; state: string; codeChallenge?: string }): string {
  const base = auth.authUrl?.trim();
  if (!base) throw new Error('The authorization code grant needs the authorize URL');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`The authorize URL ${base} is not a URL`);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', auth.clientId.trim());
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  const scopes = auth.scopes.trim();
  if (scopes) url.searchParams.set('scope', scopes);
  if (auth.audience?.trim()) url.searchParams.set('audience', auth.audience.trim());
  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/**
 * The form a token request posts, and its headers. With \`basic\` the client authenticates with an
 * Authorization header (id and secret form-encoded, as RFC 6749 asks); with \`body\`, or for a public
 * client without a secret, client_id (and the secret, when there is one) go in the form.
 */
export function tokenRequest(
  auth: Pick<OAuth2Auth, 'clientId' | 'clientSecret' | 'clientAuth'>,
  grant: Record<string, string>,
): { body: string; headers: [string, string][] } {
  const form = new URLSearchParams(grant);
  const headers: [string, string][] = [
    ['Content-Type', 'application/x-www-form-urlencoded'],
    ['Accept', 'application/json'],
  ];
  const id = auth.clientId.trim();
  const secret = auth.clientSecret;
  if (auth.clientAuth === 'basic' && secret) {
    const encode = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    headers.push(['Authorization', `Basic ${base64(`${encode(id)}:${encode(secret)}`)}`]);
  } else {
    form.set('client_id', id);
    if (secret) form.set('client_secret', secret);
  }
  return { body: form.toString(), headers };
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Read a token endpoint's answer; throws with the server's error and description when it refused. */
export function parseTokenResponse(status: number, text: string, now: number): OAuthToken {
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
  } catch {
    // Some servers answer form-encoded.
    const form = new URLSearchParams(text);
    if (form.has('access_token') || form.has('error')) json = Object.fromEntries(form);
  }
  if (!json) throw new Error(`The token endpoint answered ${status} with something that is not a token: ${text.slice(0, 200)}`);
  if (typeof json.error === 'string') {
    const description = typeof json.error_description === 'string' ? `: ${json.error_description}` : '';
    throw new Error(`The token endpoint refused (${json.error}${description})`);
  }
  if (status < 200 || status >= 300) throw new Error(`The token endpoint answered ${status}`);
  if (typeof json.access_token !== 'string' || !json.access_token) throw new Error('The token endpoint answered without an access_token');
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    ...(typeof json.refresh_token === 'string' && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
    obtainedAt: now,
  };
}

/** The callback the authorize page redirected to: the code, or the error it carries, and whether the state matches. */
export function readCallback(url: string, expectedState: string): { code: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'The sign-in came back to an address that is not a URL' };
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    const description = parsed.searchParams.get('error_description');
    return { error: `The sign-in was refused (${error}${description ? `: ${description}` : ''})` };
  }
  if (parsed.searchParams.get('state') !== expectedState) return { error: 'The sign-in came back with the wrong state; try again' };
  const code = parsed.searchParams.get('code');
  return code ? { code } : { error: 'The sign-in came back without a code' };
}
