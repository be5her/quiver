import { describe, expect, it } from 'vitest';
import { newApiRequest, type HistoryEntry } from './api';
import { canMoveCollection, collectionAncestors, collectionPath, collectionsWithMatches, historyStatusLabel, matchesHistory, matchesRequest } from './api-tree';

const collections = [
  { id: 'a', name: 'Payments', parentId: null },
  { id: 'b', name: 'Refunds', parentId: 'a' },
  { id: 'c', name: 'Deep', parentId: 'b' },
  { id: 'd', name: 'Users', parentId: null },
];

describe('matchesRequest', () => {
  const request = { name: 'Create refund', method: 'POST' as const, url: '{{baseUrl}}/v1/refunds' };
  it('needs every word somewhere in name, method or URL', () => {
    expect(matchesRequest(request, '')).toBe(true);
    expect(matchesRequest(request, 'post refunds')).toBe(true);
    expect(matchesRequest(request, 'CREATE v1')).toBe(true);
    expect(matchesRequest(request, 'post users')).toBe(false);
  });
});

describe('matchesHistory', () => {
  const entry = (status: number | null, error: string | null): HistoryEntry => ({
    id: 'h',
    at: '2026-10-17T00:00:00Z',
    requestId: null,
    method: 'GET',
    url: 'https://x.test/users',
    status,
    durationMs: 1,
    error,
    request: newApiRequest({ name: 'List users' }),
  });
  it('reads the status label too', () => {
    expect(matchesHistory(entry(404, null), 'users 404')).toBe(true);
    expect(matchesHistory(entry(null, 'Cancelled'), 'stop')).toBe(true);
    expect(matchesHistory(entry(null, 'boom'), 'err list')).toBe(true);
    expect(matchesHistory(entry(200, null), 'post')).toBe(false);
  });
  it('labels a cancelled send STOP and a failed one ERR', () => {
    expect(historyStatusLabel({ status: 201, error: null })).toBe('201');
    expect(historyStatusLabel({ status: null, error: 'Cancelled' })).toBe('STOP');
    expect(historyStatusLabel({ status: null, error: 'refused' })).toBe('ERR');
  });
});

describe('collection moves', () => {
  it('lists ancestors and survives a cycle', () => {
    expect(collectionAncestors(collections, 'c')).toEqual(['b', 'a']);
    expect(collectionAncestors([{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }], 'x')).toEqual(['y']);
  });
  it('refuses a move into itself or a descendant', () => {
    expect(canMoveCollection(collections, 'a', 'c')).toBe(false);
    expect(canMoveCollection(collections, 'a', 'a')).toBe(false);
    expect(canMoveCollection(collections, 'c', 'd')).toBe(true);
    expect(canMoveCollection(collections, 'b', null)).toBe(true);
  });
  it('names a collection by its path', () => {
    expect(collectionPath(collections, 'c')).toBe('Payments / Refunds / Deep');
  });
});

describe('collectionsWithMatches', () => {
  it('keeps the collections above every match', () => {
    const requests = [
      { name: 'refund', method: 'POST' as const, url: '/r', collectionId: 'c' },
      { name: 'list', method: 'GET' as const, url: '/u', collectionId: 'd' },
      { name: 'refund at root', method: 'GET' as const, url: '/x', collectionId: null },
    ];
    expect([...collectionsWithMatches(collections, requests, 'refund')].sort()).toEqual(['a', 'b', 'c']);
  });
});
