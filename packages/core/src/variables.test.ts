import { describe, expect, it } from 'vitest';
import { buildVariableMap, findUnresolved, resolveDeep, resolveTemplate } from './variables';

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
