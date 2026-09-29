import { describe, expect, it } from 'vitest';
import { buildVariableMap, findUnresolved, findVariableSpans, isDynamicVariable, resolveDeep, resolveTemplate, setVariableValue } from './variables';

const vars = buildVariableMap([
  [
    { id: '1', key: 'host', value: 'global.example', enabled: true },
    { id: '2', key: 'token', value: 'global-token', enabled: true },
  ],
  [
    { id: '3', key: 'host', value: 'env.example', enabled: true },
    { id: '4', key: 'disabled', value: 'nope', enabled: false },
  ],
]);

describe('variables', () => {
  it('later layers override earlier ones and disabled entries are skipped', () => {
    expect(vars).toEqual({ host: 'env.example', token: 'global-token' });
  });

  it('resolves placeholders with optional whitespace', () => {
    expect(resolveTemplate('https://{{host}}/x?t={{ token }}', vars)).toBe('https://env.example/x?t=global-token');
  });

  it('leaves unknown placeholders intact and reports them', () => {
    expect(resolveTemplate('{{missing}}', vars)).toBe('{{missing}}');
    expect(findUnresolved('{{missing}} {{host}} {{$uuid}}', vars)).toEqual(['missing']);
  });

  it('supports dynamic values', () => {
    expect(resolveTemplate('{{$uuid}}', {})).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(resolveTemplate('{{$timestamp}}', {}))).toBeGreaterThan(1_600_000_000);
  });

  it('resolves nested structures', () => {
    const out = resolveDeep({ a: '{{host}}', b: [{ c: '{{token}}' }], d: 3 }, vars);
    expect(out).toEqual({ a: 'env.example', b: [{ c: 'global-token' }], d: 3 });
  });
});

describe('findVariableSpans', () => {
  it('finds every placeholder with its offsets and trimmed name', () => {
    const text = 'https://{{host}}/v1/{{ id }}?t={{$uuid}}';
    const spans = findVariableSpans(text);
    expect(spans.map((s) => s.name)).toEqual(['host', 'id', '$uuid']);
    expect(spans.map((s) => text.slice(s.from, s.to))).toEqual(['{{host}}', '{{ id }}', '{{$uuid}}']);
  });

  it('ignores text that is not a placeholder', () => {
    expect(findVariableSpans('')).toEqual([]);
    expect(findVariableSpans('no vars')).toEqual([]);
    expect(findVariableSpans('{{}} {{1abc}} {{ spaced name }} {single}')).toEqual([]);
  });

  it('knows the built-in dynamic variables', () => {
    expect(isDynamicVariable('$uuid')).toBe(true);
    expect(isDynamicVariable('uuid')).toBe(false);
  });
});

describe('setVariableValue', () => {
  const row = (id: string, key: string, value: string, enabled = true) => ({ id, key, value, enabled });

  it('changes the row that resolution picks: the last enabled one with the key', () => {
    const layer = [row('a', 'host', 'one'), row('b', ' host ', 'two'), row('c', 'host', 'three', false), row('d', 'other', 'x')];
    const next = setVariableValue(layer, 'host', 'new');
    expect(next?.map((v) => v.value)).toEqual(['one', 'new', 'three', 'x']);
    expect(buildVariableMap([next!]).host).toBe('new');
    expect(layer[1].value).toBe('two');
  });

  it('returns null when no enabled row has the key', () => {
    expect(setVariableValue([row('a', 'host', 'one', false)], 'host', 'new')).toBeNull();
    expect(setVariableValue([], 'host', 'new')).toBeNull();
  });
});
