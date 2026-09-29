import { describe, expect, it } from 'vitest';
import { moveItem } from './arrays';

describe('moveItem', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('moves forwards and backwards to the given final index', () => {
    expect(moveItem(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(items, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(items, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('leaves the order alone for a move onto itself and clamps out-of-range targets', () => {
    expect(moveItem(items, 2, 2)).toEqual(items);
    expect(moveItem(items, 0, 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveItem(items, 2, -5)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveItem(items, 7, 0)).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd']);
  });
});
