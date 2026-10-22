import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CLI_PATH, QuiverError, cliPathLines, defineCommand, toErrorPayload, type CommandDefinition } from '@quiver/core';
import type { CliEndpoint, CliOutcome, CliRequest } from '@quiver/mcp';
import { z } from 'zod';
import { CLI_ENDPOINT_FILE, CLI_TOKEN_FILE, type CliEndpointInfo } from './cli-files';
import type { Host } from './host';

/**
 * How the `quiver` command line reaches this app (docs/cli.md). The CLI endpoint rides on the MCP server's
 * port; while that listens, the app publishes the port and a random token in its user data folder, and the
 * CLI sends the token with every call. The token is made anew on every start, so one read from an earlier
 * run is worthless, and the endpoint file goes away when the server stops.
 */
export class CliAccess {
  private readonly token = randomBytes(32).toString('hex');

  constructor(
    private readonly userDataDir: string,
    private readonly version: string,
  ) {}

  get tokenFile(): string {
    return path.join(this.userDataDir, CLI_TOKEN_FILE);
  }

  get endpointFile(): string {
    return path.join(this.userDataDir, CLI_ENDPOINT_FILE);
  }

  endpoint(host: Host): CliEndpoint {
    return { token: () => this.token, run: (request) => runCliRequest(host, request) };
  }

  /** Write the token (owner-only, through a rename so it is never readable half-written) and then the endpoint. */
  async publish(port: number): Promise<void> {
    try {
      await fs.mkdir(this.userDataDir, { recursive: true });
      const tmp = `${this.tokenFile}.${process.pid}.tmp`;
      // A temp file left by a crashed run with this pid would keep its own mode; start from none.
      await fs.rm(tmp, { force: true });
      await fs.writeFile(tmp, this.token, { mode: 0o600 });
      await fs.rename(tmp, this.tokenFile);
      const info: CliEndpointInfo = { port, url: `http://127.0.0.1:${port}${CLI_PATH}`, pid: process.pid, version: this.version };
      // Through a rename as well: a CLI starting while the app does never reads half a file.
      const endpointTmp = `${this.endpointFile}.${process.pid}.tmp`;
      await fs.writeFile(endpointTmp, `${JSON.stringify(info, null, 2)}\n`);
      await fs.rename(endpointTmp, this.endpointFile);
    } catch (err) {
      console.warn(`[quiver] the command line endpoint was not published: ${(err as Error).message}`);
    }
  }

  /** Remove the endpoint file, unless another Quiver sharing this user data folder has written its own since. */
  async withdraw(): Promise<void> {
    try {
      const info = JSON.parse(await fs.readFile(this.endpointFile, 'utf8')) as Partial<CliEndpointInfo>;
      if (info.pid === process.pid) await fs.rm(this.endpointFile, { force: true });
    } catch {
      // Not there, or not ours to read: nothing to withdraw.
    }
  }
}

/**
 * Run one CLI call as caller `cli`, in the app or in the headless CLI. A workspace command runs in the folder
 * the call names (opened for the call when it is not open yet, without adding it to the reopened ones), or in
 * the workspace the app shows; a global command ignores it.
 */
export async function runCliRequest(host: Host, request: CliRequest): Promise<CliOutcome> {
  const entry = host.registry.get(request.command);
  if (!entry) return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `Unknown command "${request.command}"; quiver list shows the commands` } };
  let workspaceId: string | null = null;
  if (entry.command.scope === 'workspace') {
    try {
      const workspace = await host.resolveWorkspace(request.workspace ?? null);
      if (!workspace) return { ok: false, error: { code: 'NO_WORKSPACE', message: `Command "${request.command}" needs a workspace: pass --workspace <folder> or run it inside the project` } };
      workspaceId = workspace.id;
    } catch (err) {
      return { ok: false, error: err instanceof QuiverError ? toErrorPayload(err) : { code: 'NOT_FOUND', message: `No workspace at ${request.workspace}: ${(err as Error).message}` } };
    }
  }
  return host.invoke(request.command, request.input ?? {}, { caller: 'cli', workspaceId });
}

/** A command's input as JSON Schema, the way the CLI coerces flags and `describe` prints it. */
function inputSchema(input: z.ZodType): unknown {
  try {
    return z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' });
  } catch {
    return {};
  }
}

/** The CLI's own commands: hidden, so they are no MCP tools; `list`, `describe` and the Settings section use them. */
export function cliCommands(host: Host, access: CliAccess, shims: string | undefined): CommandDefinition[] {
  return [
    defineCommand({
      id: 'cli.commands',
      title: 'List commands for the command line',
      description: 'Every command with its module, scope and whether it changes data. Hidden commands only with all.',
      scope: 'global',
      hidden: true,
      input: z.object({ module: z.string().optional(), all: z.boolean().optional() }),
      handler: async ({ module, all }) =>
        host.registry
          .list()
          .filter((c) => (all || !c.hidden) && (!module || c.module === module || c.id.startsWith(`${module}.`)))
          .map((c) => ({ id: c.id, module: c.module, title: c.title, scope: c.scope, mutating: c.mutating, conditional: c.conditional, hidden: c.hidden }))
          .sort((a, b) => a.id.localeCompare(b.id)),
    }),
    defineCommand({
      id: 'cli.describe',
      title: 'Describe a command for the command line',
      description: 'One command with its description and its input as JSON Schema.',
      scope: 'global',
      hidden: true,
      input: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const entry = host.registry.get(id);
        const meta = host.registry.list().find((c) => c.id === id);
        if (!entry || !meta) throw new QuiverError('UNKNOWN_COMMAND', `Unknown command "${id}"; quiver list shows the commands`);
        return { ...meta, input: inputSchema(entry.command.input) };
      },
    }),
    defineCommand({
      id: 'cli.status',
      title: 'Command line status',
      description: 'Where the command line shims are, how to put them on PATH, and whether the command line can connect to this app.',
      scope: 'global',
      hidden: true,
      input: z.object({}),
      handler: async () => {
        const mcp = host.mcpStatus();
        return {
          connected: mcp.running,
          url: mcp.running ? `http://127.0.0.1:${mcp.port}${CLI_PATH}` : null,
          mcpEnabled: host.config.get().mcp.enabled,
          endpointFile: access.endpointFile,
          tokenFile: access.tokenFile,
          platform: process.platform,
          shims: shims ?? null,
          pathLines: shims ? cliPathLines(process.platform, shims) : [],
          appImage: Boolean(shims && shims.includes('/.mount_')),
        };
      },
    }),
  ];
}
