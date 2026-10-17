import { describe, expect, it } from 'vitest';
import { ApiRequestSchema, RequestOptionsSchema, effectiveSendOptions, newApiRequest, requestOptionOverrides } from './api';

describe('effectiveSendOptions', () => {
  it('starts from the defaults', () => {
    expect(effectiveSendOptions()).toEqual({ followRedirects: true, timeoutMs: 30_000, insecure: false, maxBodyBytes: 10 * 1024 * 1024, cookies: true });
  });

  it('lets the request override the defaults and the call override the request', () => {
    const options = effectiveSendOptions({ timeoutMs: 120_000, insecure: true }, { timeoutMs: 5_000 });
    expect(options).toMatchObject({ timeoutMs: 5_000, insecure: true, followRedirects: true });
  });

  it('ignores options given as undefined', () => {
    expect(effectiveSendOptions({ timeoutMs: 2_000 }, { timeoutMs: undefined }).timeoutMs).toBe(2_000);
  });
});

describe('RequestOptionsSchema', () => {
  it('fills in no defaults, so a call that sets one option does not reset the others', () => {
    const call = RequestOptionsSchema.parse({ timeoutMs: 5_000 });
    expect(call).toEqual({ timeoutMs: 5_000 });
    expect(effectiveSendOptions({ insecure: true }, call)).toMatchObject({ insecure: true, timeoutMs: 5_000 });
  });
});

describe('requestOptionOverrides', () => {
  it('keeps only what differs from the defaults', () => {
    expect(requestOptionOverrides({ timeoutMs: 30_000, followRedirects: false, insecure: false })).toEqual({ followRedirects: false });
  });

  it('is undefined when nothing is overridden', () => {
    expect(requestOptionOverrides({ timeoutMs: 30_000 })).toBeUndefined();
    expect(requestOptionOverrides({})).toBeUndefined();
    expect(requestOptionOverrides(undefined)).toBeUndefined();
  });
});

describe('ApiRequestSchema', () => {
  it('reads a request saved before options existed', () => {
    const { options, ...older } = newApiRequest({ name: 'old' });
    expect(options).toBeUndefined();
    expect(ApiRequestSchema.parse(older).options).toBeUndefined();
  });

  it('keeps the options a request overrides', () => {
    expect(ApiRequestSchema.parse(newApiRequest({ options: { timeoutMs: 1_000 } })).options).toEqual({ timeoutMs: 1_000 });
  });
});
