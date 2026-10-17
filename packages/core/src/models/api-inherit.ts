import type { ApiAuth, ApiCollection, ApiRequest, KeyValue, RequestAuth } from './api';

/**
 * Collections as they are read from disk: files written before collections had defaults lack
 * `baseUrl`, `headers` and `auth`, so every field past the tree ones is optional here.
 */
export type CollectionLike = Pick<ApiCollection, 'id' | 'name' | 'parentId'> & Partial<Pick<ApiCollection, 'baseUrl' | 'headers' | 'auth'>>;

export interface CollectionRef {
  id: string;
  name: string;
}

/** The collections a request (or collection) sits in, from the top level down to `collectionId`. Stops on a cycle. */
export function collectionChain<C extends CollectionLike>(collections: C[], collectionId: string | null | undefined): C[] {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const chain: C[] = [];
  const seen = new Set<string>();
  let id = collectionId ?? null;
  while (id && !seen.has(id)) {
    const c = byId.get(id);
    if (!c) break;
    chain.unshift(c);
    seen.add(id);
    id = c.parentId ?? null;
  }
  return chain;
}

export interface InheritedHeader {
  header: KeyValue;
  from: CollectionRef;
}

/**
 * The headers the collections above add, from the top level down, each name once (a deeper
 * collection wins, names compared case-insensitively); disabled and nameless rows left out.
 */
export function inheritedHeaders(collections: CollectionLike[], collectionId: string | null | undefined): InheritedHeader[] {
  const byName = new Map<string, InheritedHeader>();
  for (const c of collectionChain(collections, collectionId)) {
    for (const header of c.headers ?? []) {
      if (!header.enabled || !header.key.trim()) continue;
      const name = header.key.trim().toLowerCase();
      byName.delete(name);
      byName.set(name, { header, from: { id: c.id, name: c.name } });
    }
  }
  return [...byName.values()];
}

/** The auth `inherit` resolves to from inside `collectionId`, and the collection it comes from; none at the top level. */
export function inheritedAuth(collections: CollectionLike[], collectionId: string | null | undefined): { auth: RequestAuth; from: CollectionRef | null } {
  const chain = collectionChain(collections, collectionId);
  for (let i = chain.length - 1; i >= 0; i--) {
    const auth = chain[i].auth;
    if (auth && auth.type !== 'inherit') return { auth, from: { id: chain[i].id, name: chain[i].name } };
  }
  return { auth: { type: 'none' }, from: null };
}

/** The nearest non-empty base URL above, without a trailing slash, and where it comes from. */
export function inheritedBaseUrl(collections: CollectionLike[], collectionId: string | null | undefined): { baseUrl: string; from: CollectionRef } | null {
  const chain = collectionChain(collections, collectionId);
  for (let i = chain.length - 1; i >= 0; i--) {
    const baseUrl = chain[i].baseUrl?.trim();
    if (baseUrl) return { baseUrl: baseUrl.replace(/\/+$/, ''), from: { id: chain[i].id, name: chain[i].name } };
  }
  return null;
}

/** Concrete auth: an `inherit` replaced by what it resolves to. */
export function resolveAuth(auth: ApiAuth | undefined, collections: CollectionLike[], collectionId: string | null | undefined): RequestAuth {
  if (!auth || auth.type === 'inherit') return inheritedAuth(collections, collectionId).auth;
  return auth;
}

/**
 * The request as it will be sent, before variables are resolved: the inherited headers first (minus
 * those the request sets itself, enabled, under the same name), then the request's own; `inherit`
 * auth replaced by the nearest collection's; a URL starting with `/` prefixed with the nearest base URL.
 */
export function effectiveRequest(request: ApiRequest, collections: CollectionLike[]): ApiRequest {
  const own = new Set(request.headers.filter((h) => h.enabled && h.key.trim()).map((h) => h.key.trim().toLowerCase()));
  const inherited = inheritedHeaders(collections, request.collectionId)
    .filter(({ header }) => !own.has(header.key.trim().toLowerCase()))
    .map(({ header }) => header);
  const url = request.url.trim();
  const base = url.startsWith('/') ? inheritedBaseUrl(collections, request.collectionId) : null;
  return {
    ...request,
    url: base ? `${base.baseUrl}${url}` : request.url,
    headers: [...inherited, ...request.headers],
    auth: resolveAuth(request.auth, collections, request.collectionId),
  };
}
