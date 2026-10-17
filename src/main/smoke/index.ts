import { promises as fs, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Environment, WorkspaceInfo } from '@quiver/core';
import type { Host } from '../host';
import { startFixtures } from './fixtures';
import { freePort, type PartHooks, type RpcResult, type SmokeContext, type SmokePart, type UiContext } from './part';
import api from './parts/api';
import db from './parts/db';
import env from './parts/env';
import logs from './parts/logs';
import mcp from './parts/mcp';
import mock from './parts/mock';
import realtime from './parts/realtime';
import shell from './parts/shell';
import teleport from './parts/teleport';
import todo from './parts/todo';
import tools from './parts/tools';

/** Every part, in the order they run. A full run is all of them; `npm run smoke -- db mock` picks some. */
export const PARTS: SmokePart[] = [api, tools, db, teleport, mock, realtime, mcp, env, todo, logs, shell];

type Phase = 'host' | 'renderer' | 'ui' | 'after';

interface PartReport {
  name: string;
  checks: number;
  failed: number;
  ms: Record<Phase, number>;
}

/** The parts named in QUIVER_SMOKE_PARTS (all when empty), minus those in QUIVER_SMOKE_SKIP. */
export function selectParts(only: string | undefined, skip: string | undefined): { parts: SmokePart[]; unknown: string[] } {
  const names = (value: string | undefined) => (value ?? '').split(/[\s,]+/).filter(Boolean);
  const wanted = names(only);
  const skipped = names(skip);
  const unknown = [...wanted, ...skipped].filter((n) => !PARTS.some((p) => p.name === n));
  const parts = PARTS.filter((p) => (wanted.length === 0 || wanted.includes(p.name)) && !skipped.includes(p.name));
  return { parts, unknown };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Headless end-to-end check used by `npm run smoke`. A shared core opens a workspace, an environment and Quiver's
 * MCP endpoint; then each part (one per module, plus the shell) runs its host checks, then, once the renderer has
 * loaded, its renderer and UI checks, then its after checks. Exits non-zero when any check failed.
 */
export async function runSmokeTest(host: Host, openWindow: () => BrowserWindow): Promise<number> {
  const { parts, unknown } = selectParts(process.env.QUIVER_SMOKE_PARTS, process.env.QUIVER_SMOKE_SKIP);
  if (unknown.length || parts.length === 0) {
    writeSync(2, `SMOKE FAILED: ${unknown.length ? `unknown part ${unknown.join(', ')}` : 'no part left to run'}; the parts are ${PARTS.map((p) => p.name).join(', ')}\n`);
    return 1;
  }
  const partial = parts.length < PARTS.length;
  const started = Date.now();

  const failures: string[] = [];
  let passes = 0;
  const core: PartReport = { name: 'core', checks: 0, failed: 0, ms: { host: 0, renderer: 0, ui: 0, after: 0 } };
  const reports = new Map(parts.map((p) => [p.name, { name: p.name, checks: 0, failed: 0, ms: { host: 0, renderer: 0, ui: 0, after: 0 } } satisfies PartReport]));
  let current = core;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
    current.checks++;
    if (ok) passes++;
    else {
      current.failed++;
      failures.push(name);
    }
  };
  const run = async <T>(id: string, input: unknown, workspaceId: string | null): Promise<T> => {
    const out = await host.invoke(id, input, { caller: 'ui', workspaceId });
    if (!out.ok) throw new Error(`${id}: ${out.error.code} ${out.error.message}`);
    return out.result as T;
  };
  /** Run one part's phase: its checks count towards it, and an exception fails it without stopping the others. */
  const phase = async <T>(part: SmokePart, name: Phase, body: () => Promise<T>): Promise<T | undefined> => {
    const report = reports.get(part.name)!;
    current = report;
    const t0 = Date.now();
    try {
      return await body();
    } catch (err) {
      check(`${part.name}: unexpected error in the ${name} checks: ${(err as Error).message}`, false);
      console.error(err);
      return undefined;
    } finally {
      report.ms[name] += Date.now() - t0;
      current = core;
    }
  };

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-'));
  const hooksFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-hooks-'));
  const fixtures = await startFixtures();
  let win: BrowserWindow | null = null;

  try {
    // Never share the default MCP port with a Quiver that may already be running on this machine:
    // every MCP check must hit this process, not an older build.
    const mcpPort = await freePort();
    await run('config.update', { patch: { mcp: { ...host.config.get().mcp, port: mcpPort } } }, null);
    check('mcp server listens on a private port', host.mcpStatus().running && host.mcpStatus().port === mcpPort, host.mcpStatus());

    const ws = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
    check('workspace.open', ws.path === folder, ws);

    // The environment the parts resolve {{baseUrl}} and the secret {{token}} from.
    const created = await run<Environment>('api.environment.create', { name: 'local' }, ws.id);
    const environment = await run<Environment>(
      'api.environment.save',
      {
        environment: {
          ...created,
          variables: [
            { id: 'v1', key: 'baseUrl', value: `http://127.0.0.1:${fixtures.echoPort}`, enabled: true },
            { id: 'v2', key: 'token', value: 's3cret', enabled: true, secret: true },
          ],
        },
      },
      ws.id,
    );
    await run('api.environment.setActive', { id: environment.id }, ws.id);

    // MCP over HTTP, stateless.
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
    const rpc = async (method: string, params: unknown) => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as RpcResult;
    };
    const agentRpc = async (headers: Record<string, string>, method: string, params: unknown): Promise<string | null> => {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      await res.text();
      return res.headers.get('mcp-session-id');
    };
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    check('mcp initialize', !init.error, init.error);
    const toolNames = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
    check('mcp hides plumbing', toolNames.length > 0 && !toolNames.includes('config_update'), toolNames.length);

    const t: SmokeContext = { host, check, run, ws, folder, hooksFolder, env: environment, mcpPort, rpc, agentRpc, toolNames, fixtures };
    const hooks = new Map<string, PartHooks>();
    for (const part of parts) {
      console.log(`---------- ${part.name} ----------`);
      const returned = await phase(part, 'host', () => part.run(t));
      if (returned) hooks.set(part.name, returned);
    }

    const shotsDir = process.env.QUIVER_SMOKE_SHOTS;
    const withHooks = (key: keyof PartHooks) => parts.filter((p) => hooks.get(p.name)?.[key]);
    // The renderer loads when a part has checks for it: always in a full run, which checks that it boots cleanly.
    if (withHooks('renderer').length || (shotsDir && withHooks('ui').length)) {
      win = openWindow();
      const errors: string[] = [];
      win.webContents.on('console-message', (e) => {
        if (e.level === 'error') errors.push(e.message);
      });
      await new Promise<void>((resolve, reject) => {
        win!.webContents.once('did-finish-load', () => resolve());
        win!.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`renderer failed to load: ${code} ${desc}`)));
      });
      await new Promise((r) => setTimeout(r, 2500));
      const title = await win.webContents.executeJavaScript('document.querySelector("[data-testid=app-ready]") ? "ready" : "not-ready"');
      check('renderer mounted', title === 'ready', title);

      for (const part of withHooks('renderer')) await phase(part, 'renderer', () => hooks.get(part.name)!.renderer!(win!));

      // Optional: drive the UI and capture screenshots for visual review.
      if (shotsDir) {
        await fs.mkdir(shotsDir, { recursive: true });
        const page = win;
        const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        const js = (code: string) => page.webContents.executeJavaScript(code) as Promise<unknown>;
        const shot = async (name: string) => {
          // Let the renderer paint the latest state first; otherwise the capture can be a frame behind.
          page.webContents.invalidate();
          await Promise.race([js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`), wait(500)]);
          const image = await page.webContents.capturePage();
          await fs.writeFile(path.join(shotsDir, `${name}.png`), image.toPNG());
        };
        const u: UiContext = { win: page, js, wait, shot };
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('01-welcome-dark');
        for (const part of withHooks('ui')) {
          console.log(`---------- ${part.name} ui ----------`);
          // Each part starts from the light theme and sets dark itself where a screenshot wants it.
          await js(`document.documentElement.classList.remove('dark')`);
          await phase(part, 'ui', () => hooks.get(part.name)!.ui!(u));
        }
      }

      for (const part of withHooks('after')) await phase(part, 'after', () => hooks.get(part.name)!.after!());
      check('renderer has no console errors', errors.length === 0, errors);
    } else {
      for (const part of withHooks('after')) await phase(part, 'after', () => hooks.get(part.name)!.after!());
    }
  } catch (err) {
    check(`unexpected error: ${(err as Error).message}`, false);
    console.error(err);
  } finally {
    win?.destroy();
    await fixtures.close();
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    await fs.rm(hooksFolder, { recursive: true, force: true }).catch(() => {});
  }

  console.log('---------- parts ----------');
  for (const r of [core, ...reports.values()]) {
    const times = (['host', 'renderer', 'ui', 'after'] as const).filter((p) => r.ms[p] >= 50).map((p) => `${p} ${seconds(r.ms[p])}`);
    console.log(`${r.name.padEnd(9)} ${String(r.checks).padStart(4)} checks${r.failed ? ` (${r.failed} failed)` : ''}${times.length ? `  ${times.join(', ')}` : ''}`);
  }
  const scope = partial ? `, parts: ${parts.map((p) => p.name).join(' ')}` : '';
  const elapsed = seconds(Date.now() - started);
  const summary = failures.length ? `SMOKE FAILED: ${failures.join(', ')}` : `SMOKE PASSED (${passes} checks${scope}) in ${elapsed}`;
  console.log(`MCP port used by this run: ${host.config.get().mcp.port}`);
  if (partial) console.log(`Partial run: ${PARTS.filter((p) => !parts.includes(p)).map((p) => p.name).join(', ')} did not run. Run the whole smoke before committing.`);
  try {
    // Synchronous write: piped stdout on Windows can drop the last async console.log before exit.
    writeSync(1, `${summary}\n`);
  } catch {
    console.log(summary);
  }
  return failures.length ? 1 : 0;
}
