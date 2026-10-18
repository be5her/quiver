import { describe, expect, it } from 'vitest';
import { keyValue, newApiRequest, type ApiCollection } from './api';
import { collectionChain, effectiveRequest, inheritedAuth, inheritedBaseUrl, inheritedHeaders } from './api-inherit';

const h = (key: string, value: string, enabled = true) => ({ ...keyValue(key, value, enabled), id: `${key}-${value}` });

const collections: ApiCollection[] = [
  { id: 'root', name: 'Payments', parentId: null, baseUrl: 'https://pay.test/', headers: [h('X-Tenant', 'acme'), h('X-Off', '1', false)], auth: { type: 'bearer', token: '{{token}}' }, createdAt: '' },
  { id: 'mid', name: 'Refunds', parentId: 'root', baseUrl: '', headers: [h('x-tenant', 'beta'), h('X-Trace', 'on')], auth: { type: 'inherit' }, createdAt: '' },
  { id: 'leaf', name: 'Deep', parentId: 'mid', baseUrl: '{{refundsUrl}}', headers: [], auth: { type: 'inherit' }, createdAt: '' },
];

describe('collectionChain', () => {
  it('runs from the top level down and survives cycles and unknown ids', () => {
    expect(collectionChain(collections, 'leaf').map((c) => c.id)).toEqual(['root', 'mid', 'leaf']);
    expect(collectionChain(collections, null)).toEqual([]);
    expect(collectionChain([{ id: 'a', name: 'a', parentId: 'b' }, { id: 'b', name: 'b', parentId: 'a' }], 'a').map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('inheritance', () => {
  it('lets a deeper collection replace a header by name and leaves disabled ones out', () => {
    expect(inheritedHeaders(collections, 'mid').map(({ header, from }) => `${header.key}=${header.value}@${from.name}`)).toEqual(['x-tenant=beta@Refunds', 'X-Trace=on@Refunds']);
  });

  it('takes the auth of the nearest collection that sets one, none at the top level', () => {
    expect(inheritedAuth(collections, 'leaf')).toEqual({ auth: { type: 'bearer', token: '{{token}}' }, from: { id: 'root', name: 'Payments' } });
    expect(inheritedAuth(collections, null)).toEqual({ auth: { type: 'none' }, from: null });
  });

  it('takes the nearest non-empty base URL without its trailing slash', () => {
    expect(inheritedBaseUrl(collections, 'mid')).toEqual({ baseUrl: 'https://pay.test', from: { id: 'root', name: 'Payments' } });
    expect(inheritedBaseUrl(collections, 'leaf')?.baseUrl).toBe('{{refundsUrl}}');
  });

  it('reads collections saved before they had defaults', () => {
    expect(inheritedAuth([{ id: 'old', name: 'Old', parentId: null }], 'old').auth).toEqual({ type: 'none' });
    expect(inheritedHeaders([{ id: 'old', name: 'Old', parentId: null }], 'old')).toEqual([]);
  });
});

describe('effectiveRequest', () => {
  it('merges headers, resolves inherit and prefixes a relative URL', () => {
    const request = newApiRequest({ collectionId: 'mid', url: '/refunds', auth: { type: 'inherit' }, headers: [h('X-Trace', 'off'), h('X-Tenant', 'ignored', false)] });
    const effective = effectiveRequest(request, collections);
    expect(effective.url).toBe('https://pay.test/refunds');
    expect(effective.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(effective.headers.map((x) => `${x.key}=${x.value}${x.enabled ? '' : ' (off)'}`)).toEqual(['x-tenant=beta', 'X-Trace=off', 'X-Tenant=ignored (off)']);
  });

  it('keeps an absolute URL and the request\'s own auth', () => {
    const request = newApiRequest({ collectionId: 'mid', url: 'https://other.test/x', auth: { type: 'basic', username: 'u', password: 'p' } });
    const effective = effectiveRequest(request, collections);
    expect(effective.url).toBe('https://other.test/x');
    expect(effective.auth.type).toBe('basic');
  });

  it('sends no auth for inherit at the top level and leaves a relative URL alone without a base', () => {
    const effective = effectiveRequest(newApiRequest({ url: '/x', auth: { type: 'inherit' } }), collections);
    expect(effective.auth).toEqual({ type: 'none' });
    expect(effective.url).toBe('/x');
  });
});
