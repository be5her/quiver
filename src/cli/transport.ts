import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CLI_PATH, CLI_TOKEN_HEADER, appDataFolder } from '@quiver/core';
import type { CliOutcome } from '@quiver/mcp';
import { CLI_ENDPOINT_FILE, CLI_TOKEN_FILE, type CliEndpointInfo } from '../main/cli-files';

/** How a call reaches commands: the running app over HTTP, or a Host in this process (./headless, loaded only then). */
export interface Transport {
  readonly mode: 'connected' | 'headless';
  call(command: string, input: unknown, workspace: string | null, signal?: AbortSignal): Promise<CliOutcome>;
  close(): Promise<void>;
}

/** No running Quiver answered: exit code 3, or the cue to go headless with --headless=auto. */
export class UnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreachableError';
  }
}

/** The app's user data folder: `--user-data-dir`, `QUIVER_USER_DATA_DIR`, or Electron's default for Quiver. */
export function appUserDataDir(given: string | undefined): string {
  const dir = given ?? process.env.QUIVER_USER_DATA_DIR;
  return dir ? path.resolve(dir) : path.join(appDataFolder(process.platform, process.env, os.homedir()), 'Quiver');
}

/** The headless data folder: `--data-dir`, `QUIVER_DATA_DIR`, or `quiver-cli` beside the app's own. */
export function headlessDataDir(given: string | undefined): string {
  const dir = given ?? process.env.QUIVER_DATA_DIR;
  return dir ? path.resolve(dir) : path.join(appDataFolder(process.platform, process.env, os.homedir()), 'quiver-cli');
}

/** Talk to the running app through the endpoint and token it published, after checking it answers. */
export async function connect(userDataDir: string): Promise<Transport> {
  const notRunning = `Quiver is not running, or its MCP server is off (the command line connects through it; Settings → MCP server). Start it, or add --headless to run without it.`;
  let info: CliEndpointInfo;
  let token: string;
  try {
    info = JSON.parse(await fs.readFile(path.join(userDataDir, CLI_ENDPOINT_FILE), 'utf8')) as CliEndpointInfo;
    token = (await fs.readFile(path.join(userDataDir, CLI_TOKEN_FILE), 'utf8')).trim();
  } catch {
    throw new UnreachableError(notRunning);
  }
  const base = `http://127.0.0.1:${info.port}`;
  try {
    const health = (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { name?: string };
    if (health.name !== 'quiver') throw new Error('not Quiver');
  } catch {
    throw new UnreachableError(notRunning);
  }
  return {
    mode: 'connected',
    async call(command, input, workspace, signal) {
      let res: { status: number; text: string };
      try {
        res = await post(`${base}${CLI_PATH}`, token, JSON.stringify({ command, input, workspace }), signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new UnreachableError(`Quiver stopped answering: ${(err as Error).message}`);
      }
      if (res.status === 401) throw new UnreachableError('Quiver refused the command line token. It changes on every start of the app: is another Quiver using the same user data folder?');
      let body: CliOutcome | { error?: { message?: string } } | null = null;
      try {
        body = JSON.parse(res.text) as CliOutcome | { error?: { message?: string } };
      } catch {
        // Not JSON: reported below with the status.
      }
      if (res.status !== 200 || !body || !('ok' in body)) throw new Error(`Quiver answered ${res.status}: ${(body as { error?: { message?: string } } | null)?.error?.message ?? 'no body'}`);
      return body;
    },
    async close() {},
  };
}

/**
 * One call to the endpoint with node:http rather than fetch: fetch gives up on an answer whose headers take
 * over 300 s, and a command (a long query, a slow pull) may take longer. Only `--timeout` cuts a call short.
 */
function post(url: string, token: string, body: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [CLI_TOKEN_HEADER]: token }, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
