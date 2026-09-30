import { describe, expect, it } from 'vitest';
import { keyValue, newApiRequest, type ApiRequest, type HistoryEntry } from './models/api';
import { REDACTED, isSecretName, redactHistoryEntry, redactLiteral, redactRequest, redactSent, redactUrl, requestSecretValues, scrubSecrets } from './redact';

const M = REDACTED;

describe('isSecretName', () => {
  it('knows credential headers and parameters', () => {
    for (const name of ['Authorization', 'proxy-authorization', ' Cookie ', 'X-API-Key', 'apikey', 'api_key', 'X-Auth-Token', 'access_token', 'client_secret', 'password', 'passwd', 'key', 'sig', 'X-Amz-Signature', 'X-Access-Key']) {
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it('leaves ordinary names alone', () => {
    for (const name of ['Content-Type', 'Accept', 'X-Request-Id', 'page', 'keyword', 'author', 'monkey', 'q']) expect(isSecretName(name), name).toBe(false);
  });
});

describe('redactLiteral', () => {
  it('masks literal text and keeps variable references', () => {
    expect(redactLiteral('eyJhbGciOi.payload.sig')).toBe(M);
    expect(redactLiteral('{{fina-token}}')).toBe('{{fina-token}}');
    expect(redactLiteral('{{ token }}')).toBe('{{ token }}');
    expect(redactLiteral('prefix-{{id}}-suffix')).toBe(`${M}{{id}}${M}`);
    expect(redactLiteral('{{a}} {{b}}')).toBe('{{a}} {{b}}');
  });

  it('leaves empty values empty and is stable when applied twice', () => {
    expect(redactLiteral('')).toBe('');
    expect(redactLiteral('  ')).toBe('  ');
    expect(redactLiteral(redactLiteral('secret'))).toBe(M);
  });
});

describe('scrubSecrets', () => {
  it('masks a secret as it is, URL-encoded and form-encoded', () => {
    expect(scrubSecrets('{"t":"p@ss word"}', ['p@ss word'])).toBe(`{"t":"${M}"}`);
    expect(scrubSecrets('a=p%40ss%20word&b=1', ['p@ss word'])).toBe(`a=${M}&b=1`);
    expect(scrubSecrets('a=p%40ss+word&b=1', ['p@ss word'])).toBe(`a=${M}&b=1`);
    expect(scrubSecrets('token token', ['token'])).toBe(`${M} ${M}`);
  });

  it('takes the longest secret first, skips short ones and leaves the rest of the text', () => {
    expect(scrubSecrets('abcdef abcd', ['abcd', 'abcdef'])).toBe(`${M} ${M}`);
    expect(scrubSecrets('a1 b1 c1', ['1', 'a1', ''])).toBe('a1 b1 c1');
    expect(scrubSecrets('nothing here', ['s3cret'])).toBe('nothing here');
    expect(scrubSecrets('as is')).toBe('as is');
    expect(scrubSecrets(scrubSecrets('x s3cret', ['s3cret']), ['s3cret', M])).toBe(`x ${M}`);
  });
});

describe('redactUrl', () => {
  it('masks credential query parameters and leaves the others', () => {
    expect(redactUrl('https://api.example.com/v1/items?page=2&api_key=abc123&q=a%20b')).toBe(`https://api.example.com/v1/items?page=2&api_key=${M}&q=a%20b`);
    expect(redactUrl('https://x.test/cb?access_token=tok&state=1#frag')).toBe(`https://x.test/cb?access_token=${M}&state=1#frag`);
    expect(redactUrl('https://x.test/a?flag&token=')).toBe('https://x.test/a?flag&token=');
  });

  it('masks a parameter named by the caller, whatever its case or encoding', () => {
    expect(redactUrl('https://x.test/a?X%2DCustom=abc&b=1', { names: ['x-custom'] })).toBe(`https://x.test/a?X%2DCustom=${M}&b=1`);
  });

  it('masks the password before @ and keeps the user', () => {
    expect(redactUrl('https://ada:hunter2@db.example.com:8443/x?y=1')).toBe(`https://ada:${M}@db.example.com:8443/x?y=1`);
    expect(redactUrl('https://{{user}}:{{pass}}@host/x')).toBe('https://{{user}}:{{pass}}@host/x');
    expect(redactUrl('https://host:8080/users/a@b.com?mail=a@b.com')).toBe('https://host:8080/users/a@b.com?mail=a@b.com');
  });

  it('keeps variable references in a URL that is not resolved yet', () => {
    expect(redactUrl('{{baseUrl}}/things?token={{token}}&key=literal')).toBe(`{{baseUrl}}/things?token={{token}}&key=${M}`);
  });

  it('scrubs known secret values anywhere, plain or URL-encoded, but not short ones', () => {
    expect(redactUrl('https://api.telegram.org/bot123:ABC/getMe', { values: ['123:ABC'] })).toBe(`https://api.telegram.org/bot${M}/getMe`);
    expect(redactUrl('https://x.test/a?next=p%40ss%2Fword&b=1', { values: ['p@ss/word'] })).toBe(`https://x.test/a?next=${M}&b=1`);
    expect(redactUrl('https://x.test/a1/b1?c=1', { values: ['1', 'a1'] })).toBe('https://x.test/a1/b1?c=1');
    expect(redactUrl('https://x.test/abcdef/abcd', { values: ['abcd', 'abcdef'] })).toBe(`https://x.test/${M}/${M}`);
  });

  it('changes nothing the second time', () => {
    const once = redactUrl('https://ada:pw@x.test/a?api_key=abc&sig=1', { values: ['abc'] });
    expect(redactUrl(once, { values: ['abc'] })).toBe(once);
    expect(redactUrl('')).toBe('');
  });
});

function request(partial: Partial<ApiRequest>): ApiRequest {
  return newApiRequest({ name: 'r', method: 'POST', url: 'https://merchant.example.com/auth/v1/login', ...partial });
}

describe('redactRequest', () => {
  it('masks a token typed straight into the auth tab', () => {
    const out = redactRequest(request({ auth: { type: 'bearer', token: 'eyJhbGciOi.payload.sig' } }));
    expect(out.auth).toEqual({ type: 'bearer', token: M });
  });

  it('masks the password of basic auth and the value of an API key, keeping user and key name', () => {
    expect(redactRequest(request({ auth: { type: 'basic', username: 'ada', password: 'hunter2' } })).auth).toEqual({ type: 'basic', username: 'ada', password: M });
    expect(redactRequest(request({ auth: { type: 'apikey', key: 'X-Api-Key', value: 'k-123', in: 'header' } })).auth).toEqual({ type: 'apikey', key: 'X-Api-Key', value: M, in: 'header' });
  });

  it('keeps auth that only references variables, so the request can be sent again from history', () => {
    const bearer = request({ auth: { type: 'bearer', token: '{{fina-token}}' } });
    expect(redactRequest(bearer)).toEqual(bearer);
    const none = request({});
    expect(redactRequest(none)).toEqual(none);
  });

  it('masks an Authorization header when the auth tab is not used, keeping the scheme', () => {
    const out = redactRequest(
      request({
        headers: [keyValue('Authorization', 'Bearer eyJhbGciOi'), keyValue('authorization', 'Basic YWRhOmh1bnRlcjI=', false), keyValue('Proxy-Authorization', 'rawtoken'), keyValue('Authorization', 'Bearer {{token}}'), keyValue('Accept', 'application/json')],
      }),
    );
    expect(out.headers.map((h) => h.value)).toEqual([`Bearer ${M}`, `Basic ${M}`, M, 'Bearer {{token}}', 'application/json']);
  });

  it('masks other credential headers, parameters and the URL', () => {
    const out = redactRequest(
      request({
        url: 'https://ada:pw@x.test/a?api_key=inline&page=1',
        headers: [keyValue('X-API-Key', 'k-123'), keyValue('Cookie', 'sid=abc; theme=dark'), keyValue('X-Trace', 'keep')],
        params: [keyValue('access_token', 'tok'), keyValue('page', '2'), keyValue('token', '{{t}}')],
      }),
    );
    expect(out.url).toBe(`https://ada:${M}@x.test/a?api_key=${M}&page=1`);
    expect(out.headers.map((h) => h.value)).toEqual([M, M, 'keep']);
    expect(out.params.map((p) => p.value)).toEqual([M, '2', '{{t}}']);
  });

  it('masks the parameter an API key in the query is sent as', () => {
    const out = redactRequest(request({ url: 'https://x.test/a?appid=inline', auth: { type: 'apikey', key: 'appid', value: 'k-123', in: 'query' }, params: [keyValue('appid', 'again')] }));
    expect(out.url).toBe(`https://x.test/a?appid=${M}`);
    expect(out.params[0].value).toBe(M);
  });

  it('leaves the body and the rest of the request alone, and does not change its argument', () => {
    const original = request({ body: { type: 'json', content: '{"password":"in the body"}' }, auth: { type: 'bearer', token: 'abc' }, description: 'token: see wiki' });
    const copy = structuredClone(original);
    const out = redactRequest(original);
    expect(original).toEqual(copy);
    expect(out).toEqual({ ...original, auth: { type: 'bearer', token: M } });
  });

  it('changes nothing the second time', () => {
    const once = redactRequest(request({ auth: { type: 'basic', username: 'ada', password: 'pw' }, headers: [keyValue('Authorization', 'Bearer abc')], url: 'https://x.test/a?key=1' }));
    expect(JSON.stringify(redactRequest(once))).toBe(JSON.stringify(once));
  });

  it('survives requests stored by an older version with fields missing', () => {
    const old = { id: 'x', name: 'old', method: 'GET', url: 'https://x.test/?token=abc' } as unknown as ApiRequest;
    expect(redactRequest(old).url).toBe(`https://x.test/?token=${M}`);
  });
});

describe('requestSecretValues', () => {
  it('collects what the resolved request sends as credentials', () => {
    const resolved = request({
      auth: { type: 'basic', username: 'ada', password: 'hunter2' },
      headers: [keyValue('Authorization', 'Bearer abc.def'), keyValue('X-Api-Key', ' k-123 '), keyValue('Accept', '*/*')],
      params: [keyValue('token', 'tok-9'), keyValue('page', '2'), keyValue('sig', '')],
    });
    expect(requestSecretValues(resolved)).toEqual(['hunter2', 'abc.def', 'k-123', 'tok-9']);
    expect(requestSecretValues(request({ auth: { type: 'bearer', token: 't0ken' } }))).toEqual(['t0ken']);
    expect(requestSecretValues(request({ auth: { type: 'apikey', key: 'k', value: 'v4lue', in: 'query' } }))).toEqual(['v4lue']);
  });

  it('includes credential parameters written into the URL itself', () => {
    expect(requestSecretValues(request({ url: 'https://x.test/a?page=2&api_key=in%20url&flag#token=no' }))).toEqual(['in url']);
  });
});

describe('redactSent', () => {
  const sent = {
    method: 'POST' as const,
    url: 'https://x.test/pay?ref=s3cr3t-ref&appid=k-123&page=1',
    headers: [
      ['Authorization', 'Bearer s3cr3t-tok'],
      ['X-Api-Key', 'k-123'],
      ['X-Note', 'for s3cr3t-ref'],
      ['Content-Type', 'application/json'],
    ] as [string, string][],
    bodyPreview: '{"token":"s3cr3t-tok","n":1}',
  };

  it('masks credential headers by name and the known secrets everywhere else', () => {
    expect(redactSent(sent, { names: ['appid'], values: ['s3cr3t-ref', 's3cr3t-tok'] })).toEqual({
      method: 'POST',
      url: `https://x.test/pay?ref=${M}&appid=${M}&page=1`,
      headers: [
        ['Authorization', `Bearer ${M}`],
        ['X-Api-Key', M],
        ['X-Note', `for ${M}`],
        ['Content-Type', 'application/json'],
      ],
      bodyPreview: `{"token":"${M}","n":1}`,
    });
  });

  it('still masks credential headers when nothing else is known, and copes with no body', () => {
    const out = redactSent({ ...sent, bodyPreview: null });
    expect(out.headers.slice(0, 3)).toEqual([
      ['Authorization', `Bearer ${M}`],
      ['X-Api-Key', M],
      ['X-Note', 'for s3cr3t-ref'],
    ]);
    expect(out.bodyPreview).toBeNull();
    expect(sent.headers[0][1]).toBe('Bearer s3cr3t-tok');
  });
});

describe('redactHistoryEntry', () => {
  const entry = (req: ApiRequest, url: string): HistoryEntry => ({ id: 'h1', at: '2026-09-30T10:00:00.000Z', requestId: null, method: req.method, url, status: 200, durationMs: 12, error: null, request: req });

  it('masks the stored request and the URL that went on the wire', () => {
    const req = request({ url: '{{baseUrl}}/pay', auth: { type: 'apikey', key: 'appid', value: '{{appKey}}', in: 'query' }, params: [keyValue('ref', '{{secretRef}}')] });
    const out = redactHistoryEntry(entry(req, 'https://pay.test/pay?ref=s3cr3t-ref&appid=k-123'), { values: ['s3cr3t-ref'] });
    expect(out.url).toBe(`https://pay.test/pay?ref=${M}&appid=${M}`);
    expect(out.request).toEqual(req);
    expect(out).toMatchObject({ id: 'h1', status: 200, durationMs: 12 });
  });

  it('masks a secret an error message quotes', () => {
    const failed = { ...entry(request({ url: '{{baseUrl}}/x?ref={{secretRef}}' }), 'htp:/bad/x?ref=s3cr3t-ref'), status: null, error: 'Failed to parse URL from htp:/bad/x?ref=s3cr3t-ref' };
    const out = redactHistoryEntry(failed, { values: ['s3cr3t-ref'] });
    expect(out.error).toBe(`Failed to parse URL from htp:/bad/x?ref=${M}`);
    expect(out.url).toBe(`htp:/bad/x?ref=${M}`);
    expect(Object.keys(out)).toEqual(Object.keys(failed));
  });

  it('cleans an entry written before masking existed, once', () => {
    const old = entry(request({ auth: { type: 'bearer', token: 'eyJhbGciOi' }, headers: [keyValue('Authorization', 'Bearer eyJhbGciOi')] }), 'https://merchant.example.com/auth/v1/login?api_key=abc');
    const clean = redactHistoryEntry(old);
    expect(JSON.stringify(clean)).not.toContain('eyJhbGciOi');
    expect(clean.url).toBe(`https://merchant.example.com/auth/v1/login?api_key=${M}`);
    expect(JSON.stringify(redactHistoryEntry(clean))).toBe(JSON.stringify(clean));
  });
});
