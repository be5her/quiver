import { createServer } from 'node:net';
import { CLI_TOKEN_HEADER, CommandRegistry, defaultGlobalConfig, type HostApi, type WorkspaceApi } from '@quiver/core';
import { afterEach, describe, expect, it } from 'vitest';
import { startMcpServer, type CliRequest, type RunningMcpServer } from './index';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function fakeHost(): HostApi {
  const config = defaultGlobalConfig();
  return {
    version: 'test',
    config: { get: () => config, update: async () => config },
    workspaces: { list: () => [], get: () => undefined, open: async () => ({}) as WorkspaceApi, close: async () => {} },
    secrets: { available: false, encrypt: (s) => s, decrypt: (s) => s },
    emit: () => {},
  };
}

describe('CLI endpoint', () => {
  let running: RunningMcpServer | undefined;
  /** The commands whose signal aborted while they ran. */
  const aborted: string[] = [];
  afterEach(async () => {
    aborted.length = 0;
    await running?.close();
    running = undefined;
  });

  async function start(withCli = true) {
    const seen: CliRequest[] = [];
    const port = await freePort();
    running = await startMcpServer({
      registry: new CommandRegistry(),
      host: fakeHost(),
      port,
      version: 'test',
      resolveWorkspace: async () => undefined,
      cli: withCli
        ? {
            token: () => 'tok-123',
            run: async (request, signal) => {
              seen.push(request);
              if (request.command === 'boom') throw new Error('kaput');
              if (request.command === 'slow') {
                await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
                aborted.push(request.command);
              }
              return { ok: true, result: { echoed: request.input } };
            },
          }
        : undefined,
    });
    const url = `http://127.0.0.1:${port}/cli`;
    const post = (body: unknown, headers: Record<string, string> = { [CLI_TOKEN_HEADER]: 'tok-123' }) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { url, post, seen };
  }

  it('runs a command with the right token', async () => {
    const { post, seen } = await start();
    const res = await post({ command: 'todo.add', input: { title: 'x' }, workspace: '/p' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { echoed: { title: 'x' } } });
    expect(seen).toEqual([{ command: 'todo.add', input: { title: 'x' }, workspace: '/p' }]);
  });

  it('refuses a wrong or missing token, a browser, other methods and a bad body, and runs nothing', async () => {
    const { url, post, seen } = await start();
    expect((await post({ command: 'a.b' }, { [CLI_TOKEN_HEADER]: 'tok-124' })).status).toBe(401);
    expect((await post({ command: 'a.b' }, { [CLI_TOKEN_HEADER]: 'tok' })).status).toBe(401);
    expect((await post({ command: 'a.b' }, {})).status).toBe(401);
    expect((await post({ command: 'a.b' }, { [CLI_TOKEN_HEADER]: 'tok-123', origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({ command: 'a.b' }, { origin: 'null' })).status).toBe(403);
    expect((await fetch(url)).status).toBe(405);
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ input: {} })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('answers a command that throws with its error', async () => {
    const { post } = await start();
    expect(await (await post({ command: 'boom' })).json()).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'kaput' } });
  });

  it('aborts the command when the command line stops waiting', async () => {
    const { url } = await start();
    const client = new AbortController();
    const sent = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', [CLI_TOKEN_HEADER]: 'tok-123' }, body: JSON.stringify({ command: 'slow' }), signal: client.signal });
    await new Promise((r) => setTimeout(r, 100));
    client.abort();
    await expect(sent).rejects.toThrow();
    for (let i = 0; i < 50 && !aborted.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toEqual(['slow']);
  });

  it('is off when the host gives no endpoint', async () => {
    const { post } = await start(false);
    expect((await post({ command: 'a.b' })).status).toBe(404);
  });
});
