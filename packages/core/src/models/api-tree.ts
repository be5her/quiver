import type { ApiCollection, ApiRequest, HistoryEntry } from './api';

function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word of the query appears in the request's name, method or URL (case-insensitive). An empty query matches all. */
export function matchesRequest(request: Pick<ApiRequest, 'name' | 'method' | 'url'>, query: string): boolean {
  const haystack = `${request.name}\n${request.method}\n${request.url}`.toLowerCase();
  return tokens(query).every((t) => haystack.includes(t));
}

/** The status a history row shows: the code, STOP for a cancelled send, ERR for a failed one. */
export function historyStatusLabel(entry: Pick<HistoryEntry, 'status' | 'error'>): string {
  if (entry.status !== null) return String(entry.status);
  return entry.error === 'Cancelled' ? 'STOP' : 'ERR';
}

/** Every word of the query appears in the entry's method, URL, request name or status label. */
export function matchesHistory(entry: Pick<HistoryEntry, 'method' | 'url' | 'status' | 'error' | 'request'>, query: string): boolean {
  const haystack = `${entry.method}\n${entry.url}\n${entry.request.name}\n${historyStatusLabel(entry)}`.toLowerCase();
  return tokens(query).every((t) => haystack.includes(t));
}

/** The ids of a collection's ancestors, nearest first. Stops on a cycle in hand-edited files. */
export function collectionAncestors(collections: Pick<ApiCollection, 'id' | 'parentId'>[], id: string): string[] {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const seen = new Set<string>([id]);
  const out: string[] = [];
  let parent = byId.get(id)?.parentId ?? null;
  while (parent && !seen.has(parent)) {
    out.push(parent);
    seen.add(parent);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return out;
}

/** A collection may go under `parentId` (null for the root) unless that is itself or one of its descendants. */
export function canMoveCollection(collections: Pick<ApiCollection, 'id' | 'parentId'>[], id: string, parentId: string | null): boolean {
  if (parentId === null) return true;
  if (parentId === id) return false;
  return !collectionAncestors(collections, parentId).includes(id);
}

/** The collections holding a request that matches, at any depth: the ones a filtered tree keeps and opens. */
export function collectionsWithMatches(
  collections: Pick<ApiCollection, 'id' | 'parentId'>[],
  requests: Pick<ApiRequest, 'name' | 'method' | 'url' | 'collectionId'>[],
  query: string,
): Set<string> {
  const keep = new Set<string>();
  for (const request of requests) {
    if (!request.collectionId || !matchesRequest(request, query)) continue;
    keep.add(request.collectionId);
    for (const ancestor of collectionAncestors(collections, request.collectionId)) keep.add(ancestor);
  }
  return keep;
}

/** "Parent / Child", for choosing a collection by name. */
export function collectionPath(collections: Pick<ApiCollection, 'id' | 'parentId' | 'name'>[], id: string): string {
  const byId = new Map(collections.map((c) => [c.id, c]));
  return [...collectionAncestors(collections, id).reverse(), id].map((c) => byId.get(c)?.name ?? '?').join(' / ');
}

/** Requests in their collection's order: those with an `order` first, by it, then the rest by name. */
export function compareRequests(a: Pick<ApiRequest, 'name' | 'order'>, b: Pick<ApiRequest, 'name' | 'order'>): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * The requests a run of a collection sends: its own in order, then, when recursive, each
 * sub-collection's (sub-collections by name), depth first.
 */
export function runOrder<R extends Pick<ApiRequest, 'name' | 'order' | 'collectionId'>>(
  collections: Pick<ApiCollection, 'id' | 'parentId' | 'name'>[],
  requests: R[],
  collectionId: string,
  recursive = true,
): R[] {
  const own = requests.filter((r) => r.collectionId === collectionId).sort(compareRequests);
  if (!recursive) return own;
  const children = collections.filter((c) => c.parentId === collectionId).sort((a, b) => a.name.localeCompare(b.name));
  return [...own, ...children.flatMap((c) => runOrder(collections, requests, c.id, true))];
}
