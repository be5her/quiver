import { describe, expect, it } from 'vitest';
import { createLineSplitter } from './line-splitter';

describe('createLineSplitter', () => {
  it('gives each finished line once, across chunks, skipping empty ones', () => {
    const lines = createLineSplitter();
    expect(lines.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(lines.push(':2}\r\n\n  \n{"c":3}')).toEqual(['{"b":2}']);
    expect(lines.end()).toEqual(['{"c":3}']);
    expect(lines.end()).toEqual([]);
  });
});
