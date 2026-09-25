import {
  ApiRequestSchema,
  EnvironmentSchema,
  QuiverError,
  SendOptionsSchema,
  defaultRequestName,
  defineCommand,
  defineModule,
  findUnresolved,
  newApiRequest,
  newCollection,
  newEnvironment,
  newId,
  nowIso,
  parseCurl,
  resolveDeep,
  toCurl,
  type ApiCollection,
  type ApiRequest,
  type ApiResponse,
  type CommandContext,
  type HistoryEntry,
  type WorkspaceApi,
} from '@quiver/core';
import { z } from 'zod';
import {
  COLLECTIONS,
  deleteEnvironment,
  getActiveEnvironmentId,
  getEnvironment,
  listEnvironments,
  resolveVariableMap,
  saveEnvironment,
  setActiveEnvironmentId,
} from './env';
import { prepareRequest, sendPrepared } from './http';

const HISTORY_LOG = 'history';

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

async function requireRequest(w: WorkspaceApi, id: string): Promise<ApiRequest> {
  const req = await w.store.get<ApiRequest>(COLLECTIONS.requests, id);
  if (!req) throw new QuiverError('NOT_FOUND', `Request ${id} not found`);
  return req;
}

async function resolveRequest(ctx: CommandContext, request: ApiRequest, environmentId?: string | null) {
  const vars = await resolveVariableMap(ws(ctx), ctx.host, environmentId);
  const resolved = resolveDeep(request, vars);
  const probe = [resolved.url, ...resolved.headers.map((h) => (h.enabled ? h.value : '')), JSON.stringify(resolved.auth)].join('\n');
  const missing = findUnresolved(probe, vars);
  if (missing.length) {
    throw new QuiverError('UNRESOLVED_VARIABLES', `Unresolved variables: ${missing.join(', ')}`, { missing });
  }
  return { resolved, vars };
}

// ---------- requests ----------

const requestList = defineCommand({
  id: 'api.request.list',
  title: 'List API requests',
  description: 'Lists saved HTTP requests in the workspace, with their collection ids.',
  scope: 'workspace',
  input: z.object({ collectionId: z.string().nullable().optional() }),
  handler: async ({ collectionId }, ctx) => {
    const all = await ws(ctx).store.list<ApiRequest>(COLLECTIONS.requests);
    const filtered = collectionId === undefined ? all : all.filter((r) => (r.collectionId ?? null) === collectionId);
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  },
});

const requestGet = defineCommand({
  id: 'api.request.get',
  title: 'Get API request',
  description: 'Returns one saved request by id.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => requireRequest(ws(ctx), id),
});

const requestCreate = defineCommand({
  id: 'api.request.create',
  title: 'New API request',
  description: 'Creates and saves a new request.',
  scope: 'workspace',
  input: z.object({
    name: z.string().optional(),
    method: ApiRequestSchema.shape.method.optional(),
    url: z.string().optional(),
    collectionId: z.string().nullable().optional(),
  }),
  handler: async (input, ctx) => {
    const req = newApiRequest({
      name: input.name ?? 'New request',
      method: input.method ?? 'GET',
      url: input.url ?? '',
      collectionId: input.collectionId ?? null,
    });
    return ws(ctx).store.put(COLLECTIONS.requests, req);
  },
});

const requestSave = defineCommand({
  id: 'api.request.save',
  title: 'Save API request',
  description: 'Saves a full request definition (creates or replaces by id).',
  scope: 'workspace',
  input: z.object({ request: ApiRequestSchema }),
  handler: async ({ request }, ctx) => ws(ctx).store.put(COLLECTIONS.requests, { ...request, updatedAt: nowIso() }),
});

const requestDuplicate = defineCommand({
  id: 'api.request.duplicate',
  title: 'Duplicate API request',
  description: 'Copies a saved request.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const src = await requireRequest(ws(ctx), id);
    const ts = nowIso();
    return ws(ctx).store.put(COLLECTIONS.requests, { ...src, id: newId(), name: `${src.name} copy`, createdAt: ts, updatedAt: ts });
  },
});

const requestMove = defineCommand({
  id: 'api.request.move',
  title: 'Move API request',
  description: 'Moves a request into a collection (null for the root).',
  scope: 'workspace',
  input: z.object({ id: z.string(), collectionId: z.string().nullable() }),
  handler: async ({ id, collectionId }, ctx) => {
    const req = await requireRequest(ws(ctx), id);
    return ws(ctx).store.put(COLLECTIONS.requests, { ...req, collectionId, updatedAt: nowIso() });
  },
});

const requestDelete = defineCommand({
  id: 'api.request.delete',
  title: 'Delete API request',
  description: 'Deletes a saved request.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => ({ deleted: await ws(ctx).store.remove(COLLECTIONS.requests, id) }),
});

const requestSend = defineCommand({
  id: 'api.request.send',
  title: 'Send API request',
  description:
    'Sends an HTTP request and returns status, headers, body and timings. Pass a saved requestId or an inline request. Variables like {{baseUrl}} resolve from global variables and the active (or given) environment.',
  scope: 'workspace',
  input: z.object({
    requestId: z.string().optional(),
    request: ApiRequestSchema.optional(),
    environmentId: z.string().nullable().optional(),
    options: SendOptionsSchema.partial().optional(),
    /** Record the call in workspace history. Defaults to true. */
    record: z.boolean().optional(),
  }),
  handler: async (input, ctx): Promise<ApiResponse> => {
    const w = ws(ctx);
    const request = input.request ?? (input.requestId ? await requireRequest(w, input.requestId) : null);
    if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
    const options = SendOptionsSchema.parse(input.options ?? {});
    const { resolved } = await resolveRequest(ctx, request, input.environmentId);
    const prepared = prepareRequest(resolved);

    const entry: HistoryEntry = {
      id: newId(),
      at: nowIso(),
      requestId: input.requestId ?? (request.id || null),
      method: prepared.method,
      url: prepared.url,
      status: null,
      durationMs: null,
      error: null,
      request,
    };
    try {
      const response = await sendPrepared(prepared, options);
      entry.status = response.status;
      entry.durationMs = Math.round(response.timings.total);
      return response;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (input.record !== false) await w.store.appendLog(HISTORY_LOG, entry);
    }
  },
});

// ---------- collections ----------

const collectionList = defineCommand({
  id: 'api.collection.list',
  title: 'List API collections',
  description: 'Lists request collections (folders).',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => (await ws(ctx).store.list<ApiCollection>(COLLECTIONS.collections)).sort((a, b) => a.name.localeCompare(b.name)),
});

const collectionCreate = defineCommand({
  id: 'api.collection.create',
  title: 'New API collection',
  description: 'Creates a collection (folder) for requests.',
  scope: 'workspace',
  input: z.object({ name: z.string().min(1), parentId: z.string().nullable().optional() }),
  handler: async ({ name, parentId }, ctx) => ws(ctx).store.put(COLLECTIONS.collections, newCollection(name, parentId ?? null)),
});

const collectionRename = defineCommand({
  id: 'api.collection.rename',
  title: 'Rename API collection',
  description: 'Renames a collection.',
  scope: 'workspace',
  input: z.object({ id: z.string(), name: z.string().min(1) }),
  handler: async ({ id, name }, ctx) => {
    const col = await ws(ctx).store.get<ApiCollection>(COLLECTIONS.collections, id);
    if (!col) throw new QuiverError('NOT_FOUND', `Collection ${id} not found`);
    return ws(ctx).store.put(COLLECTIONS.collections, { ...col, name });
  },
});

const collectionDelete = defineCommand({
  id: 'api.collection.delete',
  title: 'Delete API collection',
  description: 'Deletes a collection and every request and sub-collection inside it.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const collections = await w.store.list<ApiCollection>(COLLECTIONS.collections);
    const doomed = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of collections) {
        if (c.parentId && doomed.has(c.parentId) && !doomed.has(c.id)) {
          doomed.add(c.id);
          grew = true;
        }
      }
    }
    const requests = await w.store.list<ApiRequest>(COLLECTIONS.requests);
    let removedRequests = 0;
    for (const r of requests) {
      if (r.collectionId && doomed.has(r.collectionId)) {
        await w.store.remove(COLLECTIONS.requests, r.id);
        removedRequests++;
      }
    }
    for (const c of doomed) await w.store.remove(COLLECTIONS.collections, c);
    return { removedCollections: doomed.size, removedRequests };
  },
});

// ---------- environments ----------

const environmentList = defineCommand({
  id: 'api.environment.list',
  title: 'List environments',
  description: 'Lists environments with their variables. Secret values are masked for agents.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => listEnvironments(ws(ctx), ctx.host, ctx.caller === 'mcp'),
});

const environmentGet = defineCommand({
  id: 'api.environment.get',
  title: 'Get environment',
  description: 'Returns one environment by id.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const env = await getEnvironment(ws(ctx), ctx.host, id, ctx.caller === 'mcp');
    if (!env) throw new QuiverError('NOT_FOUND', `Environment ${id} not found`);
    return env;
  },
});

const environmentCreate = defineCommand({
  id: 'api.environment.create',
  title: 'New environment',
  description: 'Creates an empty environment.',
  scope: 'workspace',
  input: z.object({ name: z.string().min(1) }),
  handler: async ({ name }, ctx) => saveEnvironment(ws(ctx), ctx.host, newEnvironment(name)),
});

const environmentSave = defineCommand({
  id: 'api.environment.save',
  title: 'Save environment',
  description: 'Saves an environment. Variables flagged secret are stored encrypted on this machine only.',
  scope: 'workspace',
  input: z.object({ environment: EnvironmentSchema }),
  handler: async ({ environment }, ctx) => saveEnvironment(ws(ctx), ctx.host, environment),
});

const environmentDelete = defineCommand({
  id: 'api.environment.delete',
  title: 'Delete environment',
  description: 'Deletes an environment and its secrets.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => ({ deleted: await deleteEnvironment(ws(ctx), id) }),
});

const environmentActive = defineCommand({
  id: 'api.environment.active',
  title: 'Get active environment',
  description: 'Returns the id of the active environment, or null.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => ({ id: await getActiveEnvironmentId(ws(ctx)) }),
});

const environmentSetActive = defineCommand({
  id: 'api.environment.setActive',
  title: 'Switch environment',
  description: 'Sets the active environment for the workspace (null clears it).',
  scope: 'workspace',
  input: z.object({ id: z.string().nullable() }),
  handler: async ({ id }, ctx) => {
    if (id && !(await ws(ctx).store.get(COLLECTIONS.environments, id))) throw new QuiverError('NOT_FOUND', `Environment ${id} not found`);
    await setActiveEnvironmentId(ws(ctx), id);
    return { id };
  },
});

// ---------- history ----------

const historyList = defineCommand({
  id: 'api.history.list',
  title: 'Request history',
  description: 'Most recent sent requests with status and timing.',
  scope: 'workspace',
  input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
  handler: async ({ limit }, ctx) => ws(ctx).store.readLog<HistoryEntry>(HISTORY_LOG, limit),
});

const historyClear = defineCommand({
  id: 'api.history.clear',
  title: 'Clear request history',
  description: 'Clears the request history for this workspace.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_i, ctx) => {
    await ws(ctx).store.clearLog(HISTORY_LOG);
    ctx.host.emit('store.changed', { workspaceId: ws(ctx).id, collection: 'history' });
    return { cleared: true };
  },
});

// ---------- import / export ----------

const importCurl = defineCommand({
  id: 'api.import.curl',
  title: 'Import from curl',
  description: 'Parses a curl command and saves it as a request.',
  scope: 'workspace',
  input: z.object({ command: z.string().min(4), collectionId: z.string().nullable().optional(), name: z.string().optional() }),
  handler: async ({ command, collectionId, name }, ctx) => {
    let parsed: ApiRequest;
    try {
      parsed = parseCurl(command);
    } catch (err) {
      throw new QuiverError('INVALID_INPUT', (err as Error).message);
    }
    parsed.collectionId = collectionId ?? null;
    if (name) parsed.name = name;
    return ws(ctx).store.put(COLLECTIONS.requests, parsed);
  },
});

const exportCurl = defineCommand({
  id: 'api.export.curl',
  title: 'Copy as curl',
  description: 'Renders a request as a curl command with variables resolved.',
  scope: 'workspace',
  input: z.object({ requestId: z.string().optional(), request: ApiRequestSchema.optional(), environmentId: z.string().nullable().optional() }),
  handler: async (input, ctx) => {
    const request = input.request ?? (input.requestId ? await requireRequest(ws(ctx), input.requestId) : null);
    if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
    const vars = await resolveVariableMap(ws(ctx), ctx.host, input.environmentId);
    const prepared = prepareRequest(resolveDeep(request, vars));
    const form = request.body.type === 'form' ? request.body.fields.filter((f) => f.enabled).map((f) => [f.key, f.value] as [string, string]) : undefined;
    return {
      command: toCurl({
        method: prepared.method,
        url: prepared.url,
        headers: form ? prepared.headers.filter(([k]) => k.toLowerCase() !== 'content-type') : prepared.headers,
        body: typeof prepared.body === 'string' ? prepared.body : null,
        bodyType: form ? 'form' : 'raw',
        formFields: form,
      }),
    };
  },
});

const suggestName = defineCommand({
  id: 'api.request.suggestName',
  title: 'Suggest request name',
  description: 'Derives a display name from method and URL.',
  scope: 'global',
  hidden: true,
  input: z.object({ method: ApiRequestSchema.shape.method, url: z.string() }),
  handler: async (input) => ({ name: defaultRequestName(input) }),
});

export const apiModule = defineModule({
  id: 'api',
  commands: [
    requestList,
    requestGet,
    requestCreate,
    requestSave,
    requestDuplicate,
    requestMove,
    requestDelete,
    requestSend,
    collectionList,
    collectionCreate,
    collectionRename,
    collectionDelete,
    environmentList,
    environmentGet,
    environmentCreate,
    environmentSave,
    environmentDelete,
    environmentActive,
    environmentSetActive,
    historyList,
    historyClear,
    importCurl,
    exportCurl,
    suggestName,
  ],
});
