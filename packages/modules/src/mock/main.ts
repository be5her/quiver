import {
  MockRouteDraftSchema,
  MockRouteSchema,
  MockServerDraftSchema,
  MockServerSchema,
  QuiverError,
  compact,
  defineCommand,
  defineModule,
  matchPath,
  newId,
  newMockServer,
  nowIso,
  replayUrl,
  replayableHeaders,
  withPortRecord,
  withoutPortRecord,
  type CommandContext,
  type HostApi,
  type MockCapturedRequest,
  type MockReplayResult,
  type MockServer,
  type MockServerDraft,
  type MockServerSummary,
  type WorkspaceApi,
} from '@quiver/core';
import { fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { MockRuntime, pickPort } from './server';

export const MOCK_COLLECTION = 'mock-servers';
const REPLAY_BODY_LIMIT = 10 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|ld\+json|problem\+json)|.*\+(json|xml))/i;

const runtime = new MockRuntime();

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

async function listServers(w: WorkspaceApi): Promise<MockServer[]> {
  const out: MockServer[] = [];
  for (const item of await w.store.list<MockServer>(MOCK_COLLECTION)) {
    const parsed = MockServerSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function getServer(w: WorkspaceApi, id: string): Promise<MockServer> {
  const item = await w.store.get<MockServer>(MOCK_COLLECTION, id);
  if (!item) throw new QuiverError('NOT_FOUND', `Mock server ${id} not found`);
  return MockServerSchema.parse(item);
}

/** Remember the ports of these servers in the global config, so new servers in any project on this machine avoid them. */
async function rememberPorts(host: HostApi, w: WorkspaceApi, servers: MockServer[]): Promise<void> {
  const current = host.config.get().mock.ports;
  let next = current;
  for (const s of servers) next = withPortRecord(next, { port: s.port, workspace: w.path, serverId: s.id, name: s.name });
  if (next !== current) await host.config.update({ mock: { ports: next } });
}

async function forgetPort(host: HostApi, w: WorkspaceApi, serverId: string): Promise<void> {
  const current = host.config.get().mock.ports;
  const next = withoutPortRecord(current, w.path, serverId);
  if (next !== current) await host.config.update({ mock: { ports: next } });
}

/** Ports a new server must steer clear of: every recorded one, the servers of every open workspace and the MCP port. */
async function portsToAvoid(host: HostApi): Promise<Set<number>> {
  const config = host.config.get();
  const avoid = new Set<number>(config.mock.ports.map((r) => r.port));
  avoid.add(config.mcp.port);
  for (const info of host.workspaces.list()) {
    const open = host.workspaces.get(info.id);
    if (open) for (const s of await listServers(open)) avoid.add(s.port);
  }
  return avoid;
}

async function saveServer(ctx: CommandContext, draft: MockServerDraft): Promise<MockServerSummary> {
  const w = ws(ctx);
  const existing = draft.id ? await w.store.get<MockServer>(MOCK_COLLECTION, draft.id) : undefined;
  const merged: MockServer = MockServerSchema.parse({
    ...(existing ?? newMockServer()),
    ...compact(draft),
    id: draft.id ?? newId(),
    createdAt: existing?.createdAt ?? draft.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  if (!merged.name.trim()) merged.name = 'Mock server';
  const taken = new Set((await listServers(w)).filter((s) => s.id !== merged.id).map((s) => s.port));
  if (merged.port === 0) merged.port = await pickPort(await portsToAvoid(ctx.host));
  else if (taken.has(merged.port)) throw new QuiverError('INVALID_INPUT', `Port ${merged.port} is already used by another mock server in this workspace`);
  await w.store.put(MOCK_COLLECTION, merged);
  await rememberPorts(ctx.host, w, [merged]);
  await runtime.apply(w, ctx.host, merged);
  return runtime.summary(w, merged);
}

const ServerIdInput = z.object({ serverId: z.string().describe('Id of a mock server (see mock.server.list)') });

// ---------- servers ----------

const serverList = defineCommand({
  id: 'mock.server.list',
  title: 'List mock servers',
  description: 'Lists the mock servers and webhook receivers of this workspace with their routes, running state, URL and number of captured requests.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_input, ctx) => {
    const w = ws(ctx);
    return Promise.all((await listServers(w)).map((s) => runtime.summary(w, s)));
  },
});

const serverGet = defineCommand({
  id: 'mock.server.get',
  title: 'Get mock server',
  description: 'Returns one mock server with its routes and running state.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => runtime.summary(ws(ctx), await getServer(ws(ctx), id)),
});

const serverSave = defineCommand({
  id: 'mock.server.save',
  title: 'Save mock server',
  description:
    'Creates or updates a mock server (omit id to create). Port 0 picks a random free port that no other Quiver mock server on this machine uses. Routes match in order, first enabled match wins; `:name` captures a path segment and a trailing `*` the rest. Response bodies and headers may use {{params.x}}, {{query.x}}, {{headers.x}}, {{body.field}} and {{$uuid}}. A running server picks up changes immediately; a new port or host restarts it.',
  scope: 'workspace',
  input: z.object({ server: MockServerDraftSchema }),
  handler: async ({ server }, ctx) => saveServer(ctx, server),
});

const serverDelete = defineCommand({
  id: 'mock.server.delete',
  title: 'Delete mock server',
  description: 'Stops and deletes a mock server together with its captured requests.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    await runtime.remove(w, id);
    await forgetPort(ctx.host, w, id);
    return { deleted: await w.store.remove(MOCK_COLLECTION, id) };
  },
});

const serverStart = defineCommand({
  id: 'mock.server.start',
  title: 'Start mock server',
  description: 'Starts listening on the server port. Fails when the port is taken.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => runtime.start(ws(ctx), ctx.host, await getServer(ws(ctx), id)),
});

const serverStop = defineCommand({
  id: 'mock.server.stop',
  title: 'Stop mock server',
  description: 'Stops listening. Captured requests are kept.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const server = await getServer(w, id);
    await runtime.stop(w, id);
    return runtime.summary(w, server);
  },
});

// ---------- routes ----------

const routeSave = defineCommand({
  id: 'mock.route.save',
  title: 'Save mock route',
  description: 'Adds or updates one route of a mock server (omit route.id to add). Position inserts a new route at that index; routes match in order.',
  scope: 'workspace',
  input: ServerIdInput.extend({ route: MockRouteDraftSchema, position: z.number().int().min(0).optional() }),
  handler: async ({ serverId, route, position }, ctx) => {
    const w = ws(ctx);
    const server = await getServer(w, serverId);
    const existing = route.id ? server.routes.find((r) => r.id === route.id) : undefined;
    const merged = MockRouteSchema.parse({ ...(existing ?? {}), ...compact(route), id: route.id ?? newId() });
    const routes = existing ? server.routes.map((r) => (r.id === merged.id ? merged : r)) : [...server.routes];
    if (!existing) routes.splice(position ?? routes.length, 0, merged);
    const summary = await saveServer(ctx, { ...server, routes });
    return { route: merged, server: summary };
  },
});

const routeDelete = defineCommand({
  id: 'mock.route.delete',
  title: 'Delete mock route',
  description: 'Removes one route from a mock server.',
  scope: 'workspace',
  mutating: true,
  input: ServerIdInput.extend({ routeId: z.string() }),
  handler: async ({ serverId, routeId }, ctx) => {
    const server = await getServer(ws(ctx), serverId);
    if (!server.routes.some((r) => r.id === routeId)) throw new QuiverError('NOT_FOUND', `Route ${routeId} not found`);
    return saveServer(ctx, { ...server, routes: server.routes.filter((r) => r.id !== routeId) });
  },
});

// ---------- captured requests ----------

const requestList = defineCommand({
  id: 'mock.request.list',
  title: 'List captured requests',
  description:
    'Requests a mock server received, newest first, with headers, body (text or base64, capped at 256 KB), the matched route and what was answered. Filter by method, path pattern or time.',
  scope: 'workspace',
  input: ServerIdInput.extend({
    limit: z.number().int().min(1).max(5000).default(100),
    since: z.string().optional().describe('ISO timestamp; only requests after it'),
    method: z.string().optional(),
    path: z.string().optional().describe('Path pattern such as /hooks/:kind'),
  }),
  handler: async ({ serverId, ...opts }, ctx) => runtime.requests(ws(ctx), await getServer(ws(ctx), serverId), opts),
});

const requestGet = defineCommand({
  id: 'mock.request.get',
  title: 'Get captured request',
  description: 'Returns one captured request by id.',
  scope: 'workspace',
  input: ServerIdInput.extend({ id: z.string() }),
  handler: async ({ serverId, id }, ctx) => {
    const found = await runtime.request(ws(ctx), await getServer(ws(ctx), serverId), id);
    if (!found) throw new QuiverError('NOT_FOUND', `Captured request ${id} not found`);
    return found;
  },
});

const requestClear = defineCommand({
  id: 'mock.request.clear',
  title: 'Clear captured requests',
  description: 'Drops every captured request of a mock server.',
  scope: 'workspace',
  mutating: true,
  input: ServerIdInput,
  handler: async ({ serverId }, ctx) => ({ cleared: await runtime.clear(ws(ctx), await getServer(ws(ctx), serverId)) }),
});

const requestWait = defineCommand({
  id: 'mock.request.wait',
  title: 'Wait for a request',
  description: 'Blocks until the mock server receives the next request (optionally matching a method and path pattern) or the timeout passes. Useful right after triggering a webhook.',
  scope: 'workspace',
  input: ServerIdInput.extend({
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    method: z.string().optional(),
    path: z.string().optional().describe('Path pattern such as /hooks/:kind'),
  }),
  handler: async ({ serverId, timeoutMs, method, path }, ctx): Promise<{ request: MockCapturedRequest | null; timedOut: boolean }> => {
    const server = await getServer(ws(ctx), serverId);
    const wanted = method?.toUpperCase();
    const request = await runtime.wait(ws(ctx), server, (r) => (!wanted || r.method === wanted) && (!path || matchPath(path, r.path) !== null), timeoutMs);
    return { request, timedOut: request === null };
  },
});

const requestReplay = defineCommand({
  id: 'mock.request.replay',
  title: 'Replay captured request',
  description:
    'Sends a captured request again to another server: same method, headers (minus hop-by-hop ones) and body. Give a base URL to keep the captured path and query, or a full URL to override it.',
  scope: 'workspace',
  input: ServerIdInput.extend({
    requestId: z.string(),
    url: z.string().min(1).describe('Base URL such as http://localhost:3000, or a full URL'),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  }),
  handler: async ({ serverId, requestId, url, timeoutMs }, ctx): Promise<MockReplayResult> => {
    const w = ws(ctx);
    const captured = await runtime.request(w, await getServer(w, serverId), requestId);
    if (!captured) throw new QuiverError('NOT_FOUND', `Captured request ${requestId} not found`);
    let target: string;
    try {
      target = replayUrl(url, captured);
    } catch (err) {
      throw new QuiverError('INVALID_INPUT', (err as Error).message);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
    const started = performance.now();
    try {
      const res = await undiciFetch(target, {
        method: captured.method,
        headers: replayableHeaders(captured.headers),
        body: captured.method === 'GET' || captured.method === 'HEAD' ? undefined : Buffer.from(captured.body, captured.bodyEncoding),
        redirect: 'manual',
        signal: controller.signal,
      });
      const full = Buffer.from(await res.arrayBuffer());
      const buffer = full.subarray(0, REPLAY_BODY_LIMIT);
      const headers: [string, string][] = [];
      res.headers.forEach((v, k) => headers.push([k, v]));
      const contentType = res.headers.get('content-type');
      const isText = contentType ? TEXT_TYPES.test(contentType) : !buffer.subarray(0, 512).includes(0);
      return {
        url: target,
        status: res.status,
        statusText: res.statusText,
        headers,
        body: isText ? buffer.toString('utf8') : buffer.toString('base64'),
        bodyEncoding: isText ? 'utf8' : 'base64',
        size: full.length,
        truncated: full.length > buffer.length,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      const cause = (err as { cause?: Error }).cause;
      const message = cause?.message ? `${(err as Error).message}: ${cause.message}` : (err as Error).message;
      throw new QuiverError('REQUEST_FAILED', message, { url: target });
    } finally {
      clearTimeout(timer);
    }
  },
});

export const mockModule = defineModule({
  id: 'mock',
  commands: [serverList, serverGet, serverSave, serverDelete, serverStart, serverStop, routeSave, routeDelete, requestList, requestGet, requestClear, requestWait, requestReplay],
  onWorkspaceOpen: async (workspace, host) => {
    const servers = await listServers(workspace);
    await rememberPorts(host, workspace, servers);
    for (const server of servers) {
      if (!server.autoStart) continue;
      try {
        await runtime.start(workspace, host, server);
      } catch (err) {
        console.warn(`[quiver] mock server "${server.name}" did not start: ${(err as Error).message}`);
      }
    }
  },
  onWorkspaceClose: (workspace) => runtime.closeWorkspace(workspace),
  onStop: () => runtime.stopAll(),
});
