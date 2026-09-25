import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResultSchema,
  ToolListChangedNotificationSchema,
  type JSONRPCMessage,
  type LoggingLevel,
} from '@modelcontextprotocol/sdk/types.js';
import {
  QuiverError,
  newId,
  nowIso,
  type HostApi,
  type McpLogEntry,
  type McpLogKind,
  type McpPrompt,
  type McpPromptResult,
  type McpReadResourceResult,
  type McpResource,
  type McpResourceTemplate,
  type McpServer,
  type McpServerInfo,
  type McpServerSummary,
  type McpStatus,
  type McpTool,
  type McpToolCallOutcome,
  type McpToolResult,
  type WorkspaceApi,
} from '@quiver/core';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/** Bytes of a message kept in the log; the rest is dropped but counted. */
const DATA_LIMIT = 256 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 3000;
const LIST_PAGE_LIMIT = 50;

export type McpChangeReason = 'status' | 'servers' | 'lists' | 'log';

/** A server definition after variable resolution, ready to open. */
export type ResolvedMcpTarget =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { transport: 'http' | 'sse'; url: string; headers: [string, string][] };

interface PendingRequest {
  method: string;
  startedAt: number;
}

interface ServerState {
  workspace: WorkspaceApi;
  host: HostApi | null;
  definition: McpServer;
  status: McpStatus;
  error: string | null;
  connectedAt: string | null;
  serverInfo: McpServerInfo | null;
  capabilities: Record<string, unknown> | null;
  instructions: string | null;
  protocolVersion: string | null;
  pid: number | null;
  client: Client | null;
  /** Bumped on every connect and disconnect so callbacks of an old session are ignored. */
  generation: number;
  manual: boolean;
  tools: McpTool[] | null;
  resources: McpResource[] | null;
  templates: McpResourceTemplate[] | null;
  prompts: McpPrompt[] | null;
  pendingOut: Map<string, PendingRequest>;
  pendingIn: Map<string, PendingRequest>;
  log: McpLogEntry[];
  logLoaded: Promise<void> | null;
  emitTimer: NodeJS.Timeout | null;
  persistTimer: NodeJS.Timeout | null;
  persisting: Promise<void>;
  dirty: boolean;
}

const logName = (serverId: string) => `mcp-log-${serverId}`;

let insecureAgent: Dispatcher | null = null;
function getInsecureAgent(): Dispatcher {
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

function errorMessage(err: unknown, fallback = 'Request failed'): string {
  const e = err as { message?: string; cause?: { message?: string; code?: string }; code?: unknown; data?: unknown } | undefined;
  const cause = e?.cause;
  const parts = [e?.message, cause?.message].filter((p): p is string => Boolean(p && p.trim()));
  if (cause?.code && !parts.some((p) => p.includes(cause.code!))) parts.push(cause.code);
  return parts.length ? [...new Set(parts)].join(': ') : fallback;
}

/** Wraps a transport so every message in either direction is recorded before it is handled. */
class TappedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: unknown) => void;
  protocolVersion: string | undefined;

  constructor(
    readonly inner: Transport,
    private readonly tap: { out(message: JSONRPCMessage): void; in(message: JSONRPCMessage): void },
  ) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => {
      this.tap.in(message);
      this.onmessage?.(message, extra);
    };
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.tap.out(message);
    await this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion = (version: string): void => {
    this.protocolVersion = version;
    this.inner.setProtocolVersion?.(version);
  };
}

export class McpRuntime {
  private readonly byWorkspace = new Map<string, Map<string, ServerState>>();

  private state(ws: WorkspaceApi, definition: McpServer): ServerState {
    let map = this.byWorkspace.get(ws.id);
    if (!map) {
      map = new Map();
      this.byWorkspace.set(ws.id, map);
    }
    let s = map.get(definition.id);
    if (!s) {
      s = {
        workspace: ws,
        host: null,
        definition,
        status: 'disconnected',
        error: null,
        connectedAt: null,
        serverInfo: null,
        capabilities: null,
        instructions: null,
        protocolVersion: null,
        pid: null,
        client: null,
        generation: 0,
        manual: false,
        tools: null,
        resources: null,
        templates: null,
        prompts: null,
        pendingOut: new Map(),
        pendingIn: new Map(),
        log: [],
        logLoaded: null,
        emitTimer: null,
        persistTimer: null,
        persisting: Promise.resolve(),
        dirty: false,
      };
      map.set(definition.id, s);
    }
    return s;
  }

  private peek(workspaceId: string, serverId: string): ServerState | undefined {
    return this.byWorkspace.get(workspaceId)?.get(serverId);
  }

  private ensureLog(s: ServerState): Promise<void> {
    s.logLoaded ??= s.workspace.store
      .readLocal<McpLogEntry[]>(logName(s.definition.id), [])
      .then((entries) => {
        if (!Array.isArray(entries)) return;
        const valid = entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'string');
        s.log = [...valid, ...s.log].slice(-s.definition.logLimit);
      })
      .catch(() => undefined);
    return s.logLoaded;
  }

  async summary(ws: WorkspaceApi, definition: McpServer): Promise<McpServerSummary> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    if (s.status === 'disconnected') s.definition = definition;
    return {
      ...definition,
      status: s.status,
      error: s.error,
      connectedAt: s.connectedAt,
      serverInfo: s.serverInfo,
      capabilities: s.capabilities,
      instructions: s.instructions,
      protocolVersion: s.protocolVersion,
      pid: s.pid,
      toolCount: s.tools?.length ?? 0,
      resourceCount: (s.resources?.length ?? 0) + (s.templates?.length ?? 0),
      promptCount: s.prompts?.length ?? 0,
      logCount: s.log.length,
    };
  }

  /** The tool as last listed, used to decide whether an agent's call is read-only. */
  cachedTool(ws: WorkspaceApi, serverId: string, name: string): McpTool | undefined {
    return this.peek(ws.id, serverId)?.tools?.find((t) => t.name === name);
  }

  // ---------- session ----------

  async connect(ws: WorkspaceApi, host: HostApi, definition: McpServer, target: ResolvedMcpTarget): Promise<McpServerSummary> {
    const s = this.state(ws, definition);
    s.host = host;
    if (s.status !== 'disconnected') return this.summary(ws, s.definition);
    s.definition = definition;
    s.manual = false;
    s.error = null;
    s.status = 'connecting';
    this.notify(s, 'status');
    await this.ensureLog(s);
    const gen = ++s.generation;
    s.pendingOut.clear();
    s.pendingIn.clear();

    let inner: Transport;
    try {
      inner = this.buildTransport(s, target);
    } catch (err) {
      return this.failConnect(s, errorMessage(err, 'Invalid server definition'));
    }
    const transport = new TappedTransport(inner, {
      out: (message) => this.tapMessage(s, gen, 'out', message),
      in: (message) => this.tapMessage(s, gen, 'in', message),
    });
    const client = new Client({ name: 'quiver', version: host.version }, { capabilities: { roots: { listChanged: true } } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(ws.path).href, name: ws.name }] }));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.refreshLists(s, gen, 'tools'));
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void this.refreshLists(s, gen, 'resources'));
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => void this.refreshLists(s, gen, 'prompts'));
    client.onerror = (err) => {
      if (gen !== s.generation) return;
      const message = errorMessage(err);
      if (s.status === 'connecting') s.error = message;
      this.record(s, system(s, 'error', message));
    };
    client.onclose = () => {
      if (gen !== s.generation) return;
      const wasConnected = s.status === 'connected';
      if (s.status === 'connecting') {
        s.error ??= 'The server closed the connection before initialization finished';
      } else if (wasConnected && !s.manual) {
        s.error = target.transport === 'stdio' ? 'The server process exited' : 'The server closed the connection';
        this.record(s, system(s, 'close', s.error));
      }
      this.resetSession(s);
      this.notify(s, 'status');
    };
    s.client = client;
    this.record(s, system(s, 'info', `Connecting: ${describeTarget(target)}`));

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (err) {
      if (gen !== s.generation) return this.summary(ws, s.definition);
      const message = s.error ?? errorMessage(err, 'Could not connect');
      s.generation++;
      await Promise.race([client.close(), delay(CLOSE_TIMEOUT_MS)]).catch(() => undefined);
      return this.failConnect(s, message);
    }
    if (gen !== s.generation) return this.summary(ws, s.definition);

    s.status = 'connected';
    s.error = null;
    s.connectedAt = nowIso();
    s.serverInfo = (client.getServerVersion() as McpServerInfo | undefined) ?? null;
    s.capabilities = (client.getServerCapabilities() as Record<string, unknown> | undefined) ?? null;
    s.instructions = client.getInstructions() ?? null;
    s.protocolVersion = transport.protocolVersion ?? null;
    s.pid = inner instanceof StdioClientTransport ? inner.pid : null;
    const who = s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version}` : 'server';
    this.record(s, system(s, 'open', `Connected to ${who}${s.protocolVersion ? ` (protocol ${s.protocolVersion})` : ''}`));
    this.notify(s, 'status');
    await this.refreshLists(s, gen, 'all');
    return this.summary(ws, s.definition);
  }

  private failConnect(s: ServerState, message: string): Promise<McpServerSummary> {
    s.error = message;
    this.record(s, system(s, 'error', message));
    this.resetSession(s);
    this.notify(s, 'status');
    return this.summary(s.workspace, s.definition);
  }

  private resetSession(s: ServerState): void {
    s.status = 'disconnected';
    s.client = null;
    s.connectedAt = null;
    s.pid = null;
    s.pendingOut.clear();
    s.pendingIn.clear();
  }

  async disconnect(ws: WorkspaceApi, serverId: string): Promise<boolean> {
    const s = this.peek(ws.id, serverId);
    if (!s) return false;
    const active = s.status !== 'disconnected';
    s.manual = true;
    s.generation++;
    const client = s.client;
    s.client = null;
    if (client) {
      const transport = client.transport;
      const inner = transport instanceof TappedTransport ? transport.inner : transport;
      if (inner instanceof StreamableHTTPClientTransport && inner.sessionId) await Promise.race([inner.terminateSession(), delay(CLOSE_TIMEOUT_MS)]).catch(() => undefined);
      await Promise.race([client.close(), delay(CLOSE_TIMEOUT_MS)]).catch(() => undefined);
    }
    if (active) this.record(s, system(s, 'close', 'Disconnected'));
    this.resetSession(s);
    this.notify(s, 'status');
    await this.flush(s);
    return active;
  }

  /** Take a saved definition into account; a connected server keeps running with what it was opened with. */
  async apply(ws: WorkspaceApi, host: HostApi, definition: McpServer): Promise<void> {
    const s = this.peek(ws.id, definition.id);
    if (!s) return;
    s.host = host;
    s.definition = definition;
    if (s.log.length > definition.logLimit) {
      s.log.splice(0, s.log.length - definition.logLimit);
      this.schedulePersist(s);
    }
    this.notify(s, 'servers');
  }

  async remove(ws: WorkspaceApi, serverId: string): Promise<void> {
    const s = this.peek(ws.id, serverId);
    if (!s) return;
    await this.disconnect(ws, serverId);
    if (s.persistTimer) clearTimeout(s.persistTimer);
    s.persistTimer = null;
    s.dirty = false;
    s.log = [];
    await s.workspace.store.writeLocal(logName(serverId), []).catch(() => undefined);
    this.byWorkspace.get(ws.id)?.delete(serverId);
  }

  async closeWorkspace(ws: WorkspaceApi): Promise<void> {
    const map = this.byWorkspace.get(ws.id);
    if (!map) return;
    for (const s of map.values()) {
      await this.disconnect(ws, s.definition.id);
      await this.flush(s);
    }
    this.byWorkspace.delete(ws.id);
  }

  async stopAll(): Promise<void> {
    for (const map of [...this.byWorkspace.values()]) {
      for (const s of map.values()) await this.closeWorkspace(s.workspace);
    }
  }

  // ---------- requests ----------

  private live(ws: WorkspaceApi, definition: McpServer): { s: ServerState; client: Client } {
    const s = this.state(ws, definition);
    if (!s.client || s.status !== 'connected') throw new QuiverError('REQUEST_FAILED', `Not connected${s.error ? `: ${s.error}` : ''}`);
    return { s, client: s.client };
  }

  private async timed<T>(fn: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
    const started = performance.now();
    try {
      const value = await fn();
      return { value, durationMs: Math.round((performance.now() - started) * 10) / 10 };
    } catch (err) {
      throw new QuiverError('REQUEST_FAILED', errorMessage(err));
    }
  }

  async tools(ws: WorkspaceApi, definition: McpServer, refresh = false): Promise<McpTool[]> {
    const { s } = this.live(ws, definition);
    if (refresh || s.tools === null) await this.refreshLists(s, s.generation, 'tools');
    return s.tools ?? [];
  }

  async resources(ws: WorkspaceApi, definition: McpServer, refresh = false): Promise<{ resources: McpResource[]; templates: McpResourceTemplate[] }> {
    const { s } = this.live(ws, definition);
    if (refresh || s.resources === null) await this.refreshLists(s, s.generation, 'resources');
    return { resources: s.resources ?? [], templates: s.templates ?? [] };
  }

  async prompts(ws: WorkspaceApi, definition: McpServer, refresh = false): Promise<McpPrompt[]> {
    const { s } = this.live(ws, definition);
    if (refresh || s.prompts === null) await this.refreshLists(s, s.generation, 'prompts');
    return s.prompts ?? [];
  }

  async callTool(ws: WorkspaceApi, definition: McpServer, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpToolCallOutcome> {
    const { client } = this.live(ws, definition);
    const { value, durationMs } = await this.timed(() => client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, resetTimeoutOnProgress: true }));
    return { result: normalizeToolResult(value), durationMs };
  }

  async readResource(ws: WorkspaceApi, definition: McpServer, uri: string, timeoutMs: number): Promise<McpReadResourceResult & { durationMs: number }> {
    const { client } = this.live(ws, definition);
    const { value, durationMs } = await this.timed(() => client.readResource({ uri }, { timeout: timeoutMs }));
    return { contents: value.contents as McpReadResourceResult['contents'], durationMs };
  }

  async getPrompt(ws: WorkspaceApi, definition: McpServer, name: string, args: Record<string, string>, timeoutMs: number): Promise<McpPromptResult & { durationMs: number }> {
    const { client } = this.live(ws, definition);
    const { value, durationMs } = await this.timed(() => client.getPrompt({ name, arguments: args }, { timeout: timeoutMs }));
    return { description: value.description, messages: value.messages as McpPromptResult['messages'], durationMs };
  }

  async ping(ws: WorkspaceApi, definition: McpServer, timeoutMs: number): Promise<{ durationMs: number }> {
    const { client } = this.live(ws, definition);
    const { durationMs } = await this.timed(() => client.ping({ timeout: timeoutMs }));
    return { durationMs };
  }

  async setLoggingLevel(ws: WorkspaceApi, definition: McpServer, level: LoggingLevel): Promise<void> {
    const { client } = this.live(ws, definition);
    await this.timed(() => client.setLoggingLevel(level));
  }

  /** Any JSON-RPC request, for methods the inspector has no button for. */
  async request(ws: WorkspaceApi, definition: McpServer, method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<{ result: unknown; durationMs: number }> {
    const { client } = this.live(ws, definition);
    const { value, durationMs } = await this.timed(() => client.request({ method, params }, ResultSchema, { timeout: timeoutMs }));
    return { result: value, durationMs };
  }

  private async refreshLists(s: ServerState, gen: number, which: 'all' | 'tools' | 'resources' | 'prompts'): Promise<void> {
    const client = s.client;
    if (!client || gen !== s.generation) return;
    const caps = s.capabilities ?? {};
    const guard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (gen === s.generation) this.record(s, system(s, 'error', `Listing ${label} failed: ${errorMessage(err)}`));
        return fallback;
      }
    };
    if ((which === 'all' || which === 'tools') && caps.tools) {
      const tools = await guard('tools', () => paginate((cursor) => client.listTools({ cursor }).then((r) => ({ items: r.tools, next: r.nextCursor }))), []);
      if (gen !== s.generation) return;
      s.tools = tools as McpTool[];
    }
    if ((which === 'all' || which === 'resources') && caps.resources) {
      const resources = await guard('resources', () => paginate((cursor) => client.listResources({ cursor }).then((r) => ({ items: r.resources, next: r.nextCursor }))), []);
      const templates = await guard('resource templates', () => paginate((cursor) => client.listResourceTemplates({ cursor }).then((r) => ({ items: r.resourceTemplates, next: r.nextCursor }))), []);
      if (gen !== s.generation) return;
      s.resources = resources as McpResource[];
      s.templates = templates as McpResourceTemplate[];
    }
    if ((which === 'all' || which === 'prompts') && caps.prompts) {
      const prompts = await guard('prompts', () => paginate((cursor) => client.listPrompts({ cursor }).then((r) => ({ items: r.prompts, next: r.nextCursor }))), []);
      if (gen !== s.generation) return;
      s.prompts = prompts as McpPrompt[];
    }
    if (which === 'all') {
      s.tools ??= [];
      s.resources ??= [];
      s.templates ??= [];
      s.prompts ??= [];
    }
    this.notify(s, 'lists');
  }

  // ---------- transports ----------

  private buildTransport(s: ServerState, target: ResolvedMcpTarget): Transport {
    if (target.transport === 'stdio') {
      const transport = new StdioClientTransport({ command: target.command, args: target.args, env: { ...processEnv(), ...target.env }, cwd: target.cwd, stderr: 'pipe' });
      const gen = s.generation;
      let rest = '';
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        if (gen !== s.generation) return;
        rest += chunk.toString();
        const lines = rest.split(/\r?\n/);
        rest = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) this.record(s, entry(s, 'in', 'stderr', line));
      });
      transport.stderr?.on('end', () => {
        if (rest.trim() && gen === s.generation) this.record(s, entry(s, 'in', 'stderr', rest));
        rest = '';
      });
      return transport;
    }
    const url = new URL(target.url);
    const headers = Object.fromEntries(target.headers);
    const fetchImpl = s.definition.insecure ? insecureFetch : undefined;
    if (target.transport === 'sse') return new SSEClientTransport(url, { requestInit: { headers }, fetch: fetchImpl });
    return new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchImpl });
  }

  // ---------- log ----------

  private tapMessage(s: ServerState, gen: number, direction: 'out' | 'in', message: JSONRPCMessage): void {
    if (gen !== s.generation) return;
    const m = message as { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
    const hasId = m.id !== undefined && m.id !== null;
    const key = hasId ? String(m.id) : '';
    let kind: McpLogKind;
    let method: string | null = m.method ?? null;
    let durationMs: number | null = null;
    let ok: boolean | null = null;
    if (m.method && hasId) {
      kind = 'request';
      (direction === 'out' ? s.pendingOut : s.pendingIn).set(key, { method: m.method, startedAt: performance.now() });
    } else if (m.method) {
      kind = m.method === 'notifications/message' ? 'log' : 'notification';
    } else {
      const pending = direction === 'in' ? s.pendingOut : s.pendingIn;
      const started = pending.get(key);
      pending.delete(key);
      if (started) {
        method = started.method;
        durationMs = Math.round((performance.now() - started.startedAt) * 10) / 10;
      }
      const failed = m.error !== undefined || (m.result as { isError?: boolean } | undefined)?.isError === true;
      kind = m.error !== undefined ? 'error' : 'response';
      ok = !failed;
    }
    const record = entry(s, direction, kind, JSON.stringify(message));
    record.method = method;
    record.requestId = hasId ? (m.id as string | number) : null;
    record.durationMs = durationMs;
    record.ok = ok;
    this.record(s, record);
  }

  async logEntries(
    ws: WorkspaceApi,
    definition: McpServer,
    opts: { limit: number; since?: string; direction?: McpLogEntry['direction']; kind?: McpLogKind; method?: string; contains?: string },
  ): Promise<McpLogEntry[]> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    let list = s.log;
    if (opts.since) list = list.filter((m) => m.at > opts.since!);
    if (opts.direction) list = list.filter((m) => m.direction === opts.direction);
    if (opts.kind) list = list.filter((m) => m.kind === opts.kind);
    if (opts.method) list = list.filter((m) => m.method === opts.method);
    if (opts.contains) {
      const needle = opts.contains.toLowerCase();
      list = list.filter((m) => m.data.toLowerCase().includes(needle) || (m.method ?? '').toLowerCase().includes(needle));
    }
    return list.slice(-opts.limit);
  }

  async clearLog(ws: WorkspaceApi, definition: McpServer): Promise<number> {
    const s = this.state(ws, definition);
    await this.ensureLog(s);
    const count = s.log.length;
    s.log = [];
    this.schedulePersist(s);
    await this.flush(s);
    this.notify(s, 'log');
    return count;
  }

  private record(s: ServerState, item: McpLogEntry): void {
    s.log.push(item);
    if (s.log.length > s.definition.logLimit) s.log.splice(0, s.log.length - s.definition.logLimit);
    this.notify(s, 'log');
    this.schedulePersist(s);
  }

  private notify(s: ServerState, reason: McpChangeReason): void {
    const host = s.host;
    if (!host) return;
    const payload = { workspaceId: s.workspace.id, serverId: s.definition.id, reason };
    if (reason !== 'log') {
      host.emit('mcp.changed', payload);
      return;
    }
    if (s.emitTimer) return;
    s.emitTimer = setTimeout(() => {
      s.emitTimer = null;
      host.emit('mcp.changed', payload);
    }, 50);
  }

  private schedulePersist(s: ServerState): void {
    s.dirty = true;
    if (s.persistTimer) return;
    s.persistTimer = setTimeout(() => {
      s.persistTimer = null;
      void this.flush(s);
    }, 1000);
    s.persistTimer.unref();
  }

  private flush(s: ServerState): Promise<void> {
    if (s.persistTimer) {
      clearTimeout(s.persistTimer);
      s.persistTimer = null;
    }
    if (!s.dirty) return s.persisting;
    s.dirty = false;
    const snapshot = s.log.slice();
    s.persisting = s.persisting.then(() => s.workspace.store.writeLocal(logName(s.definition.id), snapshot)).catch(() => undefined);
    return s.persisting;
  }
}

// ---------- helpers ----------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') out[key] = value;
  return out;
}

/** Node's global fetch is undici too, but a dispatcher must come from the same undici the agent was built with. */
const insecureFetch = ((url: string | URL, init?: RequestInit) =>
  undiciFetch(url as string, { ...(init as object), dispatcher: getInsecureAgent() } as Parameters<typeof undiciFetch>[1])) as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>;

async function paginate<T>(page: (cursor: string | undefined) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < LIST_PAGE_LIMIT; i++) {
    const { items, next } = await page(cursor);
    out.push(...items);
    if (!next) break;
    cursor = next;
  }
  return out;
}

function normalizeToolResult(value: unknown): McpToolResult {
  const v = value as { content?: unknown; structuredContent?: Record<string, unknown>; isError?: boolean; toolResult?: unknown };
  if (Array.isArray(v.content)) return { content: v.content as McpToolResult['content'], structuredContent: v.structuredContent, isError: v.isError };
  // Servers from before the content array: wrap whatever they returned.
  return { content: [{ type: 'text', text: typeof v.toolResult === 'string' ? v.toolResult : JSON.stringify(v.toolResult ?? null, null, 2) }] };
}

function describeTarget(target: ResolvedMcpTarget): string {
  if (target.transport === 'stdio') return [target.command, ...target.args].join(' ');
  return `${target.transport === 'sse' ? 'SSE' : 'HTTP'} ${target.url}`;
}

function entry(s: ServerState, direction: McpLogEntry['direction'], kind: McpLogKind, data: string): McpLogEntry {
  const size = Buffer.byteLength(data, 'utf8');
  const truncated = size > DATA_LIMIT;
  return {
    id: newId(),
    serverId: s.definition.id,
    at: nowIso(),
    direction,
    kind,
    method: null,
    requestId: null,
    durationMs: null,
    ok: null,
    data: truncated ? Buffer.from(data, 'utf8').subarray(0, DATA_LIMIT).toString('utf8') : data,
    size,
    truncated,
  };
}

function system(s: ServerState, kind: 'open' | 'close' | 'error' | 'info', text: string): McpLogEntry {
  return entry(s, 'system', kind, text);
}
