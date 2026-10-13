import { describe, expect, it } from 'vitest';
import { prettyJson } from './json';

describe('prettyJson', () => {
  it('formats objects and arrays', () => {
    expect(prettyJson('{"a":1,"b":[true,null]}')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
    expect(prettyJson('  [1, 2]\n')).toBe('[\n  1,\n  2\n]');
    expect(prettyJson('{"a":{}}', 4)).toBe('{\n    "a": {}\n}');
  });

  it('leaves anything that is not an object or array alone', () => {
    expect(prettyJson('hello')).toBeNull();
    expect(prettyJson('42')).toBeNull();
    expect(prettyJson('"quoted"')).toBeNull();
    expect(prettyJson('{not json}')).toBeNull();
    expect(prettyJson('[1, 2')).toBeNull();
    expect(prettyJson('')).toBeNull();
  });

  it('keeps numbers exactly as written', () => {
    expect(prettyJson('{"id":12345678901234567890,"price":1.50,"exp":1e3}')).toBe('{\n  "id": 12345678901234567890,\n  "price": 1.50,\n  "exp": 1e3\n}');
  });
});
