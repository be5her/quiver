import {
  QuiverError,
  RealtimeConnectionDraftSchema,
  RealtimeConnectionSchema,
  applyAuth,
  compact,
  defineCommand,
  defineModule,
  findUnresolved,
  newId,
  newRealtimeConnection,
  nowIso,
  resolveDeep,
  resolveTemplate,
  type CommandContext,
  type HostApi,
  type RealtimeConnection,
  type RealtimeConnectionDraft,
  type RealtimeConnectionSummary,
  type RealtimeMessage,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import { resolveVariableMap } from '../api/env';
import { RealtimeRuntime, type ResolvedTarget } from './runtime';

export const REALTIME_COLLECTION = 'realtime-connections';

const runtime = new RealtimeRuntime();

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

async function listConnections(w: WorkspaceApi): Promise<RealtimeConnection[]> {
  const out: RealtimeConnection[] = [];
  for (const item of await w.store.list<RealtimeConnection>(REALTIME_COLLECTION)) {
    const parsed = RealtimeConnectionSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getConnection(w: WorkspaceApi, id: string): Promise<RealtimeConnection> {
  const item = await w.store.get<RealtimeConnection>(REALTIME_COLLECTION, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Connection ${id} not found`);
  return RealtimeConnectionSchema.parse(item);
}

async function saveConnection(ctx: CommandContext, draft: RealtimeConnectionDraft): Promise<RealtimeConnectionSummary> {
  const w = ws(ctx);
  const existing = draft.id ? await w.store.get<RealtimeConnection>(REALTIME_COLLECTION, draft.id) : undefined;
  const merged: RealtimeConnection = RealtimeConnectionSchema.parse({
    ...(existing ?? newRealtimeConnection()),
    ...compact(draft),
    id: draft.id ?? newId(),
    createdAt: existing?.createdAt ?? draft.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  if (!merged.name.trim()) merged.name = merged.kind === 'sse' ? 'Event stream' : 'WebSocket';
  await w.store.put(REALTIME_COLLECTION, merged);
  await runtime.apply(w, ctx.host, merged);
  return runtime.summary(w, merged);
}

/** Resolve variables in URL, headers, auth and body, then fold the auth in. */
async function resolveTarget(w: WorkspaceApi, host: HostApi, conn: RealtimeConnection, environmentId?: string | null): Promise<{ target: ResolvedTarget; vars: Record<string, string> }> {
  const vars = await resolveVariableMap(w, host, environmentId);
  const resolved = resolveDeep(conn, vars);
  const probe = [resolved.url, ...resolved.headers.map((h) => (h.enabled ? h.value : '')), JSON.stringify(resolved.auth), resolved.body].join('\n');
  const missing = findUnresolved(probe, vars);
  if (missing.length) throw new QuiverError('UNRESOLVED_VARIABLES', `Unresolved variables: ${missing.join(', ')}`, { missing });
  const headers: [string, string][] = resolved.headers.filter((h) => h.enabled && h.key.trim()).map((h) => [h.key.trim(), h.value]);
  const withAuth = applyAuth(resolved.auth, headers, resolved.url.trim());
  if (!withAuth.url) throw new QuiverError('INVALID_INPUT', 'The connection has no URL');
  return { target: { url: withAuth.url, headers: withAuth.headers, body: resolved.body }, vars };
}

const ConnectionIdInput = z.object({ id: z.string().describe('Id of a connection (see realtime.connection.list)') });

// ---------- connections ----------

const connectionList = defineCommand({
  id: 'realtime.connection.list',
  title: 'List realtime connections',
  description: 'Lists the WebSocket and SSE connections of this workspace with their status (disconnected, connecting, open, reconnecting) and message counts.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => {
    const w = ws(ctx);
    return Promise.all((await listConnections(w)).map((c) => runtime.summary(w, c)));
  },
});

const connectionGet = defineCommand({
  id: 'realtime.connection.get',
  title: 'Get realtime connection',
  description: 'Returns one connection with its status.',
  scope: 'workspace',
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => runtime.summary(ws(ctx), await getConnection(ws(ctx), id)),
});

const connectionSave = defineCommand({
  id: 'realtime.connection.save',
  title: 'Save realtime connection',
  description:
    'Creates or updates a WebSocket (`kind: websocket`) or Server-Sent Events (`kind: sse`) connection; omit id to create. URL, headers, auth and body accept {{variables}}. Only the fields given are changed. An open connection keeps running until reconnected.',
  scope: 'workspace',
  input: z.object({ connection: RealtimeConnectionDraftSchema }),
  handler: async ({ connection }, ctx) => saveConnection(ctx, connection),
});

const connectionDelete = defineCommand({
  id: 'realtime.connection.delete',
  title: 'Delete realtime connection',
  description: 'Disconnects and deletes a connection together with its message log.',
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    await runtime.remove(w, id);
    return { deleted: await w.store.remove(REALTIME_COLLECTION, id) };
  },
});

// ---------- session ----------

const connect = defineCommand({
  id: 'realtime.connect',
  title: 'Connect',
  description:
    'Opens a WebSocket or SSE connection with variables resolved from the active (or given) environment and waits for the handshake. Returns the connection with its status; a failure is reported in `error`. Messages arrive in the log (realtime.message.list, realtime.message.wait).',
  scope: 'workspace',
  input: ConnectionIdInput.extend({ environmentId: z.string().nullable().optional() }),
  handler: async ({ id, environmentId }, ctx) => {
    const w = ws(ctx);
    const conn = await getConnection(w, id);
    const { target } = await resolveTarget(w, ctx.host, conn, environmentId);
    return runtime.connect(w, ctx.host, conn, target);
  },
});

const disconnect = defineCommand({
  id: 'realtime.disconnect',
  title: 'Disconnect',
  description: 'Closes a connection and stops reconnecting. The message log is kept.',
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const conn = await getConnection(w, id);
    await runtime.disconnect(w, id);
    return runtime.summary(w, conn);
  },
});

const send = defineCommand({
  id: 'realtime.send',
  title: 'Send message',
  description:
    'Sends a message over an open WebSocket connection: `data` as text (variables resolved), or `messageId` to send one of the saved messages of the connection. Set `binary` to send `data` decoded from base64 as a binary frame. Returns the recorded outgoing message.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({
    data: z.string().optional(),
    messageId: z.string().optional().describe('Id of a saved message of the connection'),
    binary: z.boolean().optional(),
    environmentId: z.string().nullable().optional(),
  }),
  handler: async ({ id, data, messageId, binary, environmentId }, ctx) => {
    const w = ws(ctx);
    const conn = await getConnection(w, id);
    let text = data;
    if (messageId) {
      const saved = conn.messages.find((m) => m.id === messageId);
      if (!saved) throw new QuiverError('NOT_FOUND', `Saved message ${messageId} not found`);
      text = saved.body;
    }
    if (text === undefined) throw new QuiverError('INVALID_INPUT', 'Provide data or messageId');
    if (!binary) text = resolveTemplate(text, await resolveVariableMap(w, ctx.host, environmentId));
    return runtime.send(w, conn, text, binary === true);
  },
});

// ---------- messages ----------

const messageList = defineCommand({
  id: 'realtime.message.list',
  title: 'List messages',
  description:
    'Messages of a connection, oldest first: incoming (`in`), sent (`out`) and system entries (`system`: open, close, error, reconnect). SSE entries carry `event` and `eventId`. Filter by direction, event name, text or time (`since`, ISO); `limit` keeps the newest.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({
    limit: z.number().int().min(1).max(5000).default(100),
    since: z.string().optional(),
    direction: z.enum(['in', 'out', 'system']).optional(),
    contains: z.string().optional(),
    event: z.string().optional(),
  }),
  handler: async ({ id, ...opts }, ctx) => runtime.messages(ws(ctx), await getConnection(ws(ctx), id), opts),
});

const messageClear = defineCommand({
  id: 'realtime.message.clear',
  title: 'Clear messages',
  description: 'Drops the message log of a connection.',
  scope: 'workspace',
  mutating: true,
  input: ConnectionIdInput,
  handler: async ({ id }, ctx) => ({ cleared: await runtime.clear(ws(ctx), await getConnection(ws(ctx), id)) }),
});

const messageWait = defineCommand({
  id: 'realtime.message.wait',
  title: 'Wait for a message',
  description:
    'Blocks until the next message that matches arrives on a connection, or until the timeout. By default waits for an incoming message; narrow with `event` (SSE event name) or `contains` (text). Returns `{ message, timedOut }`.',
  scope: 'workspace',
  input: ConnectionIdInput.extend({
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    direction: z.enum(['in', 'out', 'system']).default('in'),
    contains: z.string().optional(),
    event: z.string().optional(),
  }),
  handler: async ({ id, timeoutMs, direction, contains, event }, ctx) => {
    const conn = await getConnection(ws(ctx), id);
    const needle = contains?.toLowerCase();
    const message = await runtime.wait(
      ws(ctx),
      conn,
      (m: RealtimeMessage) =>
        m.direction === direction && (!event || m.event === event) && (!needle || (m.encoding === 'utf8' && m.data.toLowerCase().includes(needle))),
      timeoutMs,
    );
    return { message, timedOut: message === null };
  },
});

export const realtimeModule = defineModule({
  id: 'realtime',
  commands: [connectionList, connectionGet, connectionSave, connectionDelete, connect, disconnect, send, messageList, messageClear, messageWait],
  onWorkspaceOpen: async (workspace, host) => {
    for (const conn of await listConnections(workspace)) {
      if (!conn.autoConnect) continue;
      try {
        const { target } = await resolveTarget(workspace, host, conn);
        await runtime.connect(workspace, host, conn, target);
      } catch (err) {
        console.warn(`[quiver] connection "${conn.name}" did not open: ${(err as Error).message}`);
      }
    }
  },
  onWorkspaceClose: (workspace) => runtime.closeWorkspace(workspace),
  onStop: () => runtime.stopAll(),
});
