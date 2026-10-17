import { createServer as createTcpServer } from 'node:net';
import type { BrowserWindow } from 'electron';
import type { Environment, WorkspaceInfo } from '@quiver/core';
import type { Host } from '../host';
import type { Fixtures } from './fixtures';

/** What an MCP call answers, as far as the checks read it. */
export interface RpcResult {
  result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
  error?: unknown;
}

/** Everything a part gets for its host checks: the host, the shared workspace and the local fakes. */
export interface SmokeContext {
  host: Host;
  /** Record a check; `detail` is printed with it. */
  check: (name: string, ok: boolean, detail?: unknown) => void;
  /** Invoke a command as the UI; throws when it fails. */
  run: <T>(id: string, input: unknown, workspaceId: string | null) => Promise<T>;
  /** The workspace every part works in, a fresh temporary folder. */
  ws: WorkspaceInfo;
  folder: string;
  /** A second temporary folder for parts that need one outside the workspace. */
  hooksFolder: string;
  /** The active environment "local": baseUrl points at the echo server, token is the secret "s3cret". */
  env: Environment;
  /** The port of Quiver's own MCP server for this run. */
  mcpPort: number;
  /** One stateless MCP request to Quiver's own server for the workspace. */
  rpc: (method: string, params: unknown) => Promise<RpcResult>;
  /** A request with headers of its own, as one particular agent; gives back the session id the server handed out, if any. */
  agentRpc: (headers: Record<string, string>, method: string, params: unknown) => Promise<string | null>;
  /** The tool names Quiver's MCP server lists. */
  toolNames: string[];
  fixtures: Fixtures;
}

/** What a part gets for its UI checks, which only run with QUIVER_SMOKE_SHOTS. */
export interface UiContext {
  win: BrowserWindow;
  /** Run code in the renderer and get its result. */
  js: (code: string) => Promise<unknown>;
  wait: (ms: number) => Promise<void>;
  /** Capture the window into `<QUIVER_SMOKE_SHOTS>/<name>.png`. */
  shot: (name: string) => Promise<void>;
}

/** What a part hands back after its host checks; each hook runs in its own phase, in part order. */
export interface PartHooks {
  /** Once the renderer has loaded, with or without screenshots. */
  renderer?: (win: BrowserWindow) => Promise<void>;
  /** With QUIVER_SMOKE_SHOTS: drive the UI and capture screenshots. */
  ui?: (u: UiContext) => Promise<void>;
  /** After every part's UI checks, for checks that must wait until the UI is done with the state. */
  after?: () => Promise<void>;
}

export interface SmokePart {
  /** The name used to pick it: `npm run smoke -- <name>`. Same as the file name. */
  name: string;
  /** One line for `npm run smoke -- --list`. */
  summary: string;
  /** The host checks; runs first. */
  run: (t: SmokeContext) => Promise<PartHooks | void>;
}

export function definePart(part: SmokePart): SmokePart {
  return part;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll until the predicate holds or the time is up; resolves to whether it held. */
export async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await predicate()) return true;
  return Boolean(await predicate());
}
