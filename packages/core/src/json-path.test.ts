import { describe, expect, it } from 'vitest';
import { MAX_JSON_PATH_RESULTS, jsonPath } from './json-path';

const doc = {
  store: {
    book: [
      { title: 'A', price: 8, author: { name: 'Ann' } },
      { title: 'B', price: 12, 'odd key': true },
      { title: 'C', price: 9 },
    ],
    bike: { color: 'red', price: 20 },
  },
  'with.dot': 1,
};

describe('jsonPath', () => {
  it('reads keys, indexes and quoted keys', () => {
    expect(jsonPath(doc, '$')).toEqual([doc]);
    expect(jsonPath(doc, '$.store.bike.color')).toEqual(['red']);
    expect(jsonPath(doc, '$.store.book[1].title')).toEqual(['B']);
    expect(jsonPath(doc, "$['with.dot']")).toEqual([1]);
    expect(jsonPath(doc, '$.store.book[1]["odd key"]')).toEqual([true]);
  });

  it('counts negative indexes from the end', () => {
    expect(jsonPath(doc, '$.store.book[-1].title')).toEqual(['C']);
    expect(jsonPath(doc, '$.store.book[5]')).toEqual([]);
  });

  it('expands wildcards over arrays and objects', () => {
    expect(jsonPath(doc, '$.store.book[*].price')).toEqual([8, 12, 9]);
    expect(jsonPath(doc, '$.store.bike.*')).toEqual(['red', 20]);
  });

  it('finds keys at any depth', () => {
    expect(jsonPath(doc, '$..price')).toEqual([8, 12, 9, 20]);
    expect(jsonPath(doc, '$..name')).toEqual(['Ann']);
    expect(jsonPath({ a: [1, { b: 2 }] }, '$..*')).toEqual([[1, { b: 2 }], 1, { b: 2 }, 2]);
  });

  it('walks each node once in a chain of deep segments, quickly, and refuses a selection that is too big', () => {
    let chain: unknown = { a: 1 };
    for (let i = 0; i < 300; i++) chain = { a: chain };
    const started = Date.now();
    const found = jsonPath(chain, '$..a..a..a..a');
    expect(Date.now() - started).toBeLessThan(500);
    // 301 objects carry `a`; each deep segment after the first starts one level further down.
    expect(found).toHaveLength(298);
    expect(found[found.length - 1]).toBe(1);
    expect(jsonPath({ x: { a: { a: 2 } } }, '$..a..a')).toEqual([2]);
    expect(() => jsonPath({ a: Array.from({ length: MAX_JSON_PATH_RESULTS + 1 }, (_, i) => i) }, '$.a[*]')).toThrow(/more than 50000 values/);
  });

  it('accepts a path without the leading $', () => {
    expect(jsonPath(doc, 'store.bike.price')).toEqual([20]);
    expect(jsonPath([10, 20], '[0]')).toEqual([10]);
  });

  it('selects nothing for keys that are not there', () => {
    expect(jsonPath(doc, '$.nope.deeper')).toEqual([]);
    expect(jsonPath('text', '$.length')).toEqual([]);
  });

  it('refuses what it does not support, saying where', () => {
    expect(() => jsonPath(doc, '$.store.book[?(@.price<10)]')).toThrow(/not supported/);
    expect(() => jsonPath(doc, '$.store.book[0')).toThrow(/Missing "]"/);
    expect(() => jsonPath(doc, "$['open")).toThrow(/Unterminated/);
    expect(() => jsonPath(doc, '$.')).toThrow(/Expected a key/);
  });
});
