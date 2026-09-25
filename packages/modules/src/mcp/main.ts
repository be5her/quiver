import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MCP_CONFIG_FILES,
  MCP_LOGGING_LEVELS,
  McpServerDraftSchema,
  McpServerSchema,
  QuiverError,
  applyAuth,
  compact,
  defineCommand,
  defineModule,
  expandEnvRefs,
  findUnresolved,
  newId,
  newMcpServer,
  nowIso,
  parseMcpConfig,
  resolveDeep,
  transportLabel,
  type CommandContext,
  type HostApi,
  type McpConfigEntry,
  type McpConfigFile,
  type McpServer,
  type McpServerDraft,
  type McpServerSummary,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { resolveVariableMap } from '../api/env';
import { McpRuntime, type ResolvedMcpTarget } from './runtime';

export const MCP_COLLECTION = 'mcp-servers';

const runtime = new McpRuntime();

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

async function listServers(w: WorkspaceApi): Promise<McpServer[]> {
  const out: McpServer[] = [];
  for (const item of await w.store.list<McpServer>(MCP_COLLECTION)) {
    const parsed = McpServerSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getServer(w: WorkspaceApi, id: string): Promise<McpServer> {
  const item = await w.store.get<McpServer>(MCP_COLLECTION, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Server ${id} not found`);
  return McpServerSchema.parse(item);
}

async function saveServer(ctx: CommandContext, draft: McpServerDraft): Promise<McpServerSummary> {
  const w = ws(ctx);
  const existing = draft.id ? await w.store.get<McpServer>(MCP_COLLECTION, draft.id) : undefined;
  const merged: McpServer = McpServerSchema.parse({
    ...(existing ?? newMcpServer()),
    ...compact(draft),
    id: draft.id ?? newId(),
    createdAt: existing?.createdAt ?? draft.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  if (!merged.name.trim()) merged.name = 'Server';
  await w.store.put(MCP_COLLECTION, merged);
  await runtime.apply(w, ctx.host, merged);
  return runtime.summary(w, merged);
}

/** Resolve `{{variables}}` then `${ENV}` references, fold the auth in, and check nothing is left unresolved. */
async function resolveTarget(w: WorkspaceApi, host: HostApi, server: McpServer, environmentId?: string | null): Promise<ResolvedMcpTarget> {
  const vars = await resolveVariableMap(w, host, environmentId);
  const resolved = resolveDeep(server, vars);
  const env = process.env;
  const expand = (text: string) => expandEnvRefs(text, env);
  const probe = [
    resolved.command,
    ...resolved.args,
    resolved.url,
    resolved.cwd,
    ...resolved.env.map((e) => (e.enabled ? e.value : '')),
    ...resolved.headers.map((h) => (h.enabled ? h.value : '')),
    JSON.stringify(resolved.auth),
  ].join('\n');
  const missing = findUnresolved(probe, vars);
  if (missing.length) throw new QuiverError('UNRESOLVED_VARIABLES', `Unresolved variables: ${missing.join(', ')}`, { missing });
  if (server.transport === 'stdio') {
    const command = expand(resolved.command.trim());
    if (!command) throw new QuiverError('INVALID_INPUT', 'The server has no command');
    const envEntries = resolved.env.filter((e) => e.enabled && e.key.trim()).map((e) => [e.key.trim(), expand(e.value)] as [string, string]);
    return { transport: 'stdio', command, args: resolved.args.map(expand), env: Object.fromEntries(envEntries), cwd: path.resolve(w.path, expand(resolved.cwd.trim()) || '.') };
  }
  const headers: [string, string][] = resolved.headers.filter((h) => h.enabled && h.key.trim()).map((h) => [h.key.trim(), expand(h.value)]);
  const withAuth = applyAuth(resolved.auth, headers, expand(resolved.url.trim()));
  if (!withAuth.url) throw new QuiverError('INVALID_INPUT', 'The server has no URL');
  return { transport: server.transport, url: withAuth.url, headers: withAuth.headers };
}

// ---------- project config files ----------

async function readConfigFile(w: WorkspaceApi, file: string): Promise<{ entries: McpConfigEntry[]; error: string | null } | null> {
  const full = path.resolve(w.path, file);
  const relative = path.relative(w.path, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new QuiverError('INVALID_INPUT', 'The config file must be inside the project folder');
  let text: string;
  try {
    text = await fs.readFile(full, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { entries: [], error: (err as Error).message };
  }
  try {
    return { entries: parseMcpConfig(text), error: null };
  } catch (err) {
    return { entries: [], error: `Not valid JSON: ${(err as Error).message}` };
  }
}

async function discover(w: WorkspaceApi, files: readonly string[]): Promise<McpConfigFile[]> {
  const saved = await listServers(w);
  const out: McpConfigFile[] = [];
  for (const file of files) {
    const read = await readConfigFile(w, file);
    if (!read) continue;
    out.push({
      file,
      error: read.error,
      servers: read.entries.map((e) => ({
        name: e.name,
        transport: e.draft.transport ?? 'stdio',
        description: e.draft.transport === 'stdio' || !e.draft.transport ? [e.draft.command ?? '', ...(e.draft.args ?? [])].join(' ').trim() : `${transportLabel(e.draft.transport)} ${e.draft.url ?? ''}`,
        imported: saved.some((s) => s.importedFrom === file && s.name === e.name),
      })),
    });
  }
  return out;
}

const ServerIdInput = z.object({ id: z.string().describe('Id of a server (see mcp.server.list)') });
const TimeoutInput = { timeoutMs: z.number().int().min(100).max(600_000).default(60_000) };

// ---------- servers ----------

const serverList = defineCommand({
  id: 'mcp.server.list',
  title: 'List MCP servers',
  description: 'Lists the MCP servers saved in this workspace with their connection status, server info and tool, resource and prompt counts.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => {
    const w = ws(ctx);
    return Promise.all((await listServers(w)).map((s) => runtime.summary(w, s)));
  },
});

const serverGet = defineCommand({
  id: 'mcp.server.get',
  title: 'Get MCP server',
  description: 'Returns one server with its status, capabilities and instructions.',
  scope: 'workspace',
  input: ServerIdInput,
  handler: async ({ id }, ctx) => runtime.summary(ws(ctx), await getServer(ws(ctx), id)),
});

const serverSave = defineCommand({
  id: 'mcp.server.save',
  title: 'Save MCP server',
  description:
    'Creates or updates an MCP server definition; omit id to create. `transport` is `stdio` (command, args, env, cwd), `http` (Streamable HTTP: url, headers, auth) or `sse` (legacy SSE). Strings accept {{variables}} and ${ENV} references. Only the fields given are changed; a connected server keeps running until reconnected.',
  scope: 'workspace',
  input: z.object({ server: McpServerDraftSchema }),
  handler: async ({ server }, ctx) => saveServer(ctx, server),
});

const serverDelete = defineCommand({
  id: 'mcp.server.delete',
  title: 'Delete MCP server',
  description: 'Disconnects and deletes a server definition together with its log.',
  scope: 'workspace',
  mutating: true,
  input: ServerIdInput,
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    await runtime.remove(w, id);
    return { deleted: await w.store.remove(MCP_COLLECTION, id) };
  },
});

const serverDiscover = defineCommand({
  id: 'mcp.server.discover',
  title: 'Find MCP servers in project files',
  description: 'Reads the MCP config files other tools keep in the project (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`) and lists the servers they declare, without importing them.',
  scope: 'workspace',
  input: z.object({ file: z.string().optional().describe('One file, relative to the project folder; default: every known file') }),
  handler: async ({ file }, ctx) => discover(ws(ctx), file ? [file] : MCP_CONFIG_FILES),
});

const serverImport = defineCommand({
  id: 'mcp.server.import',
  title: 'Import MCP servers from project files',
  description: 'Saves the servers declared in a project config file (`.mcp.json` by default) as inspector servers. Re-importing updates the servers imported earlier from the same file. Returns the saved servers.',
  scope: 'workspace',
  input: z.object({
    file: z.string().optional().describe('Config file relative to the project folder; default: every known file that exists'),
    names: z.array(z.string()).optional().describe('Only these server names'),
  }),
  handler: async ({ file, names }, ctx) => {
    const w = ws(ctx);
    const files = file ? [file] : MCP_CONFIG_FILES;
    const saved = await listServers(w);
    const out: McpServerSummary[] = [];
    let found = 0;
    for (const f of files) {
      const read = await readConfigFile(w, f);
      if (!read) continue;
      if (read.error) throw new QuiverError('INVALID_INPUT', `${f}: ${read.error}`);
      for (const entry of read.entries) {
        found++;
        if (names && !names.includes(entry.name)) continue;
        const existing = saved.find((s) => s.importedFrom === f && s.name === entry.name);
        out.push(await saveServer(ctx, { ...entry.draft, id: existing?.id, importedFrom: f }));
      }
    }
    if (file && found === 0 && !(await readConfigFile(w, file))) throw new QuiverError('NOT_FOUND', `${file} not found in the project`);
    return out;
  },
});

// ---------- session ----------

const connect = defineCommand({
  id: 'mcp.connect',
  title: 'Connect to MCP server',
  description:
    'Starts (stdio) or opens (http, sse) an MCP server with variables resolved from the active (or given) environment, runs the initialize handshake and lists its tools, resources and prompts. Returns the server with its status; a failure is reported in `error`.',
  scope: 'workspace',
  input: ServerIdInput.extend({ environmentId: z.string().nullable().optional() }),
  handler: async ({ id, environmentId }, ctx) => {
    const w = ws(ctx);
    const server = await getServer(w, id);
    const target = await resolveTarget(w, ctx.host, server, environmentId);
    return runtime.connect(w, ctx.host, server, target);
  },
});

const disconnect = defineCommand({
  id: 'mcp.disconnect',
  title: 'Disconnect from MCP server',
  description: 'Closes the session; a stdio server process is stopped. The log is kept.',
  scope: 'workspace',
  mutating: true,
  input: ServerIdInput,
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const server = await getServer(w, id);
    await runtime.disconnect(w, id);
    return runtime.summary(w, server);
  },
});

const ping = defineCommand({
  id: 'mcp.ping',
  title: 'Ping MCP server',
  description: 'Sends a ping request to a connected server and returns the round-trip time.',
  scope: 'workspace',
  input: ServerIdInput.extend({ timeoutMs: z.number().int().min(100).max(60_000).default(10_000) }),
  handler: async ({ id, timeoutMs }, ctx) => runtime.ping(ws(ctx), await getServer(ws(ctx), id), timeoutMs),
});

// ---------- tools, resources, prompts ----------

const toolList = defineCommand({
  id: 'mcp.tool.list',
  title: 'List MCP tools',
  description: 'Tools of a connected server with their input schemas and annotations. Pass `refresh` to ask the server again instead of using the cached list.',
  scope: 'workspace',
  input: ServerIdInput.extend({ refresh: z.boolean().optional() }),
  handler: async ({ id, refresh }, ctx) => runtime.tools(ws(ctx), await getServer(ws(ctx), id), refresh === true),
});

const toolCall = defineCommand({
  id: 'mcp.tool.call',
  title: 'Call MCP tool',
  description:
    'Calls a tool of a connected server with JSON arguments and returns `{ result, durationMs }`; `result.isError` is set when the tool reported a failure. For agents, tools annotated `readOnlyHint` always work; other tools need "allow mutations" in Quiver settings.',
  scope: 'workspace',
  mutating: ({ id, name }, ctx) => runtime.cachedTool(ws(ctx), id, name)?.annotations?.readOnlyHint !== true,
  input: ServerIdInput.extend({
    name: z.string().describe('Tool name as listed by mcp.tool.list'),
    arguments: z.record(z.string(), z.unknown()).default({}),
    ...TimeoutInput,
  }),
  handler: async ({ id, name, arguments: args, timeoutMs }, ctx) => runtime.callTool(ws(ctx), await getServer(ws(ctx), id), name, args, timeoutMs),
});

const resourceList = defineCommand({
  id: 'mcp.resource.list',
  title: 'List MCP resources',
  description: 'Resources and resource templates of a connected server. Pass `refresh` to ask the server again.',
  scope: 'workspace',
  input: ServerIdInput.extend({ refresh: z.boolean().optional() }),
  handler: async ({ id, refresh }, ctx) => runtime.resources(ws(ctx), await getServer(ws(ctx), id), refresh === true),
});

const resourceRead = defineCommand({
  id: 'mcp.resource.read',
  title: 'Read MCP resource',
  description: 'Reads a resource by URI (expand a template yourself) and returns its contents: text, or base64 in `blob` for binary data.',
  scope: 'workspace',
  input: ServerIdInput.extend({ uri: z.string(), ...TimeoutInput }),
  handler: async ({ id, uri, timeoutMs }, ctx) => runtime.readResource(ws(ctx), await getServer(ws(ctx), id), uri, timeoutMs),
});

const promptList = defineCommand({
  id: 'mcp.prompt.list',
  title: 'List MCP prompts',
  description: 'Prompts of a connected server with their arguments. Pass `refresh` to ask the server again.',
  scope: 'workspace',
  input: ServerIdInput.extend({ refresh: z.boolean().optional() }),
  handler: async ({ id, refresh }, ctx) => runtime.prompts(ws(ctx), await getServer(ws(ctx), id), refresh === true),
});

const promptGet = defineCommand({
  id: 'mcp.prompt.get',
  title: 'Get MCP prompt',
  description: 'Renders a prompt with string arguments and returns its messages.',
  scope: 'workspace',
  input: ServerIdInput.extend({ name: z.string(), arguments: z.record(z.string(), z.string()).default({}), ...TimeoutInput }),
  handler: async ({ id, name, arguments: args, timeoutMs }, ctx) => runtime.getPrompt(ws(ctx), await getServer(ws(ctx), id), name, args, timeoutMs),
});

const rawRequest = defineCommand({
  id: 'mcp.request',
  title: 'Send raw MCP request',
  description: 'Sends any JSON-RPC request (method and params) to a connected server and returns the raw result, for methods the inspector has no dedicated command for.',
  scope: 'workspace',
  mutating: true,
  input: ServerIdInput.extend({ method: z.string(), params: z.record(z.string(), z.unknown()).optional(), ...TimeoutInput }),
  handler: async ({ id, method, params, timeoutMs }, ctx) => runtime.request(ws(ctx), await getServer(ws(ctx), id), method, params, timeoutMs),
});

const loggingLevel = defineCommand({
  id: 'mcp.logging.level',
  title: 'Set MCP logging level',
  description: 'Asks a connected server that supports logging to send log notifications at this level and above; they appear in the log.',
  scope: 'workspace',
  input: ServerIdInput.extend({ level: z.enum(MCP_LOGGING_LEVELS) }),
  handler: async ({ id, level }, ctx) => {
    await runtime.setLoggingLevel(ws(ctx), await getServer(ws(ctx), id), level);
    return { level };
  },
});

// ---------- log ----------

const logList = defineCommand({
  id: 'mcp.log.list',
  title: 'List MCP log',
  description:
    'The traffic log of a server, oldest first: every JSON-RPC request, response, error and notification in both directions (`out` is Quiver to server), stderr lines of stdio servers, and connection events. Filter by direction, kind, method, text or time; `limit` keeps the newest.',
  scope: 'workspace',
  input: ServerIdInput.extend({
    limit: z.number().int().min(1).max(5000).default(100),
    since: z.string().optional(),
    direction: z.enum(['in', 'out', 'system']).optional(),
    kind: z.enum(['request', 'response', 'error', 'notification', 'log', 'stderr', 'info', 'open', 'close']).optional(),
    method: z.string().optional(),
    contains: z.string().optional(),
  }),
  handler: async ({ id, ...opts }, ctx) => runtime.logEntries(ws(ctx), await getServer(ws(ctx), id), opts),
});

const logClear = defineCommand({
  id: 'mcp.log.clear',
  title: 'Clear MCP log',
  description: 'Drops the log of a server.',
  scope: 'workspace',
  mutating: true,
  input: ServerIdInput,
  handler: async ({ id }, ctx) => ({ cleared: await runtime.clearLog(ws(ctx), await getServer(ws(ctx), id)) }),
});

export const mcpModule = defineModule({
  id: 'mcp',
  commands: [serverList, serverGet, serverSave, serverDelete, serverDiscover, serverImport, connect, disconnect, ping, toolList, toolCall, resourceList, resourceRead, promptList, promptGet, rawRequest, loggingLevel, logList, logClear],
  onWorkspaceOpen: async (workspace, host) => {
    for (const server of await listServers(workspace)) {
      if (!server.autoConnect) continue;
      try {
        const target = await resolveTarget(workspace, host, server);
        await runtime.connect(workspace, host, server, target);
      } catch (err) {
        console.warn(`[quiver] MCP server "${server.name}" did not connect: ${(err as Error).message}`);
      }
    }
  },
  onWorkspaceClose: (workspace) => runtime.closeWorkspace(workspace),
  onStop: () => runtime.stopAll(),
});
