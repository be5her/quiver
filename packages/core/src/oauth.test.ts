import { describe, expect, it } from 'vitest';
import { authorizeUrl, oauthIdentity, parseTokenResponse, readCallback, tokenIsFresh, tokenRequest } from './oauth';

const auth = { grant: 'authorization_code' as const, tokenUrl: 'https://id.test/token', authUrl: 'https://id.test/authorize?prompt=login', clientId: 'quiver', clientSecret: 's e/cret', scopes: 'read write', audience: 'api', clientAuth: 'basic' as const };

describe('oauthIdentity', () => {
  it('ignores the order of scopes and surrounding space', () => {
    expect(oauthIdentity({ ...auth, scopes: 'write  read ' })).toBe(oauthIdentity(auth));
    expect(oauthIdentity({ ...auth, clientId: 'other' })).not.toBe(oauthIdentity(auth));
  });
});

describe('authorizeUrl', () => {
  it('adds the standard parameters to the page, keeping its own', () => {
    const url = new URL(authorizeUrl(auth, { redirectUri: 'http://127.0.0.1:5000/callback', state: 'st', codeChallenge: 'ch' }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'login',
      response_type: 'code',
      client_id: 'quiver',
      redirect_uri: 'http://127.0.0.1:5000/callback',
      state: 'st',
      scope: 'read write',
      audience: 'api',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('needs an authorize URL', () => {
    expect(() => authorizeUrl({ ...auth, authUrl: '' }, { redirectUri: 'x', state: 's' })).toThrow(/authorize URL/);
  });
});

describe('tokenRequest', () => {
  it('authenticates with a Basic header, id and secret form-encoded', () => {
    const { body, headers } = tokenRequest(auth, { grant_type: 'client_credentials', scope: 'read' });
    expect(body).toBe('grant_type=client_credentials&scope=read');
    expect(headers).toContainEqual(['Authorization', `Basic ${btoa('quiver:s+e%2Fcret')}`]);
  });

  it('puts the client in the body when asked, or when there is no secret', () => {
    expect(tokenRequest({ ...auth, clientAuth: 'body' }, { grant_type: 'refresh_token' }).body).toBe('grant_type=refresh_token&client_id=quiver&client_secret=s+e%2Fcret');
    const pub = tokenRequest({ ...auth, clientSecret: '' }, { grant_type: 'authorization_code', code: 'c' });
    expect(pub.body).toBe('grant_type=authorization_code&code=c&client_id=quiver');
    expect(pub.headers.some(([k]) => k === 'Authorization')).toBe(false);
  });
});

describe('parseTokenResponse', () => {
  it('reads a JSON token with its expiry and refresh token', () => {
    expect(parseTokenResponse(200, '{"access_token":"a","token_type":"bearer","expires_in":3600,"refresh_token":"r","scope":"read"}', 1000)).toEqual({
      accessToken: 'a',
      tokenType: 'bearer',
      expiresAt: 1000 + 3_600_000,
      refreshToken: 'r',
      scope: 'read',
      obtainedAt: 1000,
    });
  });

  it('reads a form-encoded token and one without an expiry', () => {
    expect(parseTokenResponse(200, 'access_token=a&token_type=bearer', 5)).toMatchObject({ accessToken: 'a', expiresAt: null });
  });

  it('says what the server refused', () => {
    expect(() => parseTokenResponse(400, '{"error":"invalid_client","error_description":"bad secret"}', 0)).toThrow('The token endpoint refused (invalid_client: bad secret)');
    expect(() => parseTokenResponse(500, 'oops', 0)).toThrow(/not a token/);
    expect(() => parseTokenResponse(200, '{"token_type":"bearer"}', 0)).toThrow(/without an access_token/);
  });
});

describe('tokenIsFresh', () => {
  it('treats the last 30 seconds as expired', () => {
    expect(tokenIsFresh({ expiresAt: 100_000 }, 60_000)).toBe(true);
    expect(tokenIsFresh({ expiresAt: 100_000 }, 75_000)).toBe(false);
    expect(tokenIsFresh({ expiresAt: null }, 1e15)).toBe(true);
  });
});

describe('readCallback', () => {
  it('takes the code when the state matches', () => {
    expect(readCallback('http://127.0.0.1:1/callback?code=c&state=s', 's')).toEqual({ code: 'c' });
  });
  it('reports an error, a wrong state and a missing code', () => {
    expect(readCallback('http://127.0.0.1:1/callback?error=access_denied&error_description=no', 's')).toEqual({ error: 'The sign-in was refused (access_denied: no)' });
    expect(readCallback('http://127.0.0.1:1/callback?code=c&state=x', 's')).toMatchObject({ error: expect.stringContaining('wrong state') });
    expect(readCallback('http://127.0.0.1:1/callback?state=s', 's')).toMatchObject({ error: expect.stringContaining('without a code') });
  });
});
