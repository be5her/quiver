import {
  DEFINABLE_VARIABLE_NAME,
  ApiCollectionSchema,
  ApiRequestSchema,
  OAuth2AuthSchema,
  EnvironmentSchema,
  QuiverError,
  REDACTED,
  RequestBodySchema,
  RequestOptionsSchema,
  defaultRequestName,
  canMoveCollection,
  defineCommand,
  defineVariableIn,
  defineModule,
  effectiveRequest,
  storeCookies,
  extractCapture,
  effectiveSendOptions,
  cookiesFor,
  resolveAuth,
  findUnresolved,
  newApiRequest,
  newCollection,
  newEnvironment,
  newId,
  nowIso,
  parseCurl,
  redactHistoryEntry,
  redactRequest,
  redactSent,
  redactUrl,
  requestSecretValues,
  resolveDeep,
  scrubSecrets,
  toCurl,
  type ApiCollection,
  type ApiRequest,
  type ApiAuth,
  type JarCookie,
  type ApiResponse,
  type CapturedValue,
  type CurlFormField,
  type CommandContext,
  type HistoryEntry,
  type RedactUrlOptions,
  type WorkspaceApi,
} from '@quiver/core';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  COLLECTIONS,
  deleteEnvironment,
  getActiveEnvironmentId,
  getEnvironment,
  listEnvironments,
  resolveVariableMap,
  saveEnvironment,
  secretVariableValues,
  setActiveEnvironmentId,
  listResolvedVariables,
  setResolvedVariable,
  variableSource,
  defineVariable,
} from './env';
import { graphqlEndpoint, introspect, readSchema } from './graphql';
import { prepareRequest, sendPrepared } from './http';
import { clearOAuthToken, getOAuthToken, oauthStatus } from './oauth';
import { jarSession, readJar, writeJar } from './cookies';

const HISTORY_LOG = 'history';

/**
 * History written before credentials were masked still holds them in plain text, so the log is
 * rewritten once when its workspace opens. Reads and appends wait for that, so nothing is lost or reordered.
 */
const historyReady = new Map<string, Promise<void>>();

async function scrubHistory(w: WorkspaceApi): Promise<void> {
  const entries = (await w.store.readLog<HistoryEntry>(HISTORY_LOG, Number.MAX_SAFE_INTEGER)).reverse();
  const clean = entries.map((entry) => redactHistoryEntry(entry));
  if (JSON.stringify(clean) === JSON.stringify(entries)) return;
  await w.store.clearLog(HISTORY_LOG);
  for (const entry of clean) await w.store.appendLog(HISTORY_LOG, entry);
}

function ws(ctx: CommandContext): WorkspaceApi {
  return ctx.workspace!;
}

async function requireRequest(w: WorkspaceApi, id: string): Promise<ApiRequest> {
  const req = await w.store.get<ApiRequest>(COLLECTIONS.requests, id);
  if (!req) throw new QuiverError('NOT_FOUND', `Request ${id} not found`);
  return req;
}

/** Collections as stored, with the defaults of fields added after older files were written. */
async function listCollections(w: WorkspaceApi): Promise<ApiCollection[]> {
  const stored = await w.store.list<ApiCollection>(COLLECTIONS.collections);
  return stored.map((c) => {
    const parsed = ApiCollectionSchema.safeParse(c);
    return parsed.success ? parsed.data : c;
  });
}

/** The request with what its collections add: inherited headers, auth and base URL (see `effectiveRequest`). */
async function withInheritance(w: WorkspaceApi, request: ApiRequest): Promise<ApiRequest> {
  return effectiveRequest(request, await listCollections(w));
}

async function resolveRequest(ctx: CommandContext, request: ApiRequest, environmentId?: string | null) {
  const vars = await resolveVariableMap(ws(ctx), ctx.host, environmentId);
  const resolved = resolveDeep(await withInheritance(ws(ctx), request), vars);
  const probe = [resolved.url, ...resolved.headers.map((h) => (h.enabled ? h.value : '')), JSON.stringify(resolved.auth)].join('\n');
  const missing = findUnresolved(probe, vars);
  if (missing.length) {
    throw new QuiverError('UNRESOLVED_VARIABLES', `Unresolved variables: ${missing.join(', ')}`, { missing });
  }
  return { resolved, vars };
}

/**
 * The credentials a resolved request carries and the secret variables it can use: what is masked in
 * whatever gets written down about the request, or handed back to an agent.
 */
async function knownSecrets(ctx: CommandContext, resolved: ApiRequest, environmentId?: string | null): Promise<RedactUrlOptions> {
  return {
    names: resolved.auth.type === 'apikey' && resolved.auth.in === 'query' ? [resolved.auth.key] : [],
    values: [...requestSecretValues(resolved), ...(await secretVariableValues(ws(ctx), ctx.host, environmentId))],
  };
}

/**
 * Run a request's captures on its response and write what they read into the environment (the given
 * one, else the active one) in a single save. A capture that reads nothing, or a send without an
 * environment, is reported as failed and the send still succeeds. An existing secret stays secret.
 */
async function runCaptures(ctx: CommandContext, request: ApiRequest, response: ApiResponse, environmentId?: string | null): Promise<CapturedValue[] | undefined> {
  const captures = (request.capture ?? []).filter((c) => c.enabled && c.variable.trim());
  if (!captures.length) return undefined;
  const w = ws(ctx);
  const envId = environmentId === undefined ? await getActiveEnvironmentId(w) : environmentId;
  const env = envId ? await getEnvironment(w, ctx.host, envId) : undefined;
  const results: CapturedValue[] = captures.map((capture) => {
    const variable = capture.variable.trim();
    const secret = capture.secret || Boolean(env?.variables.some((v) => v.enabled && v.key.trim() === variable && v.secret));
    const read = extractCapture(capture, response);
    return read.ok ? { variable, value: read.value, ok: true, secret } : { variable, value: null, ok: false, error: read.error, secret };
  });
  const fail = (error: string) => results.map((r) => (r.ok ? { ...r, value: null, ok: false, error } : r));
  if (!env) return fail('No environment is active, so there is nowhere to write it');
  let variables = env.variables;
  results.forEach((r, i) => {
    if (r.ok && r.value !== null) variables = defineVariableIn(variables, r.variable, r.value, newId(), captures[i].secret);
  });
  if (variables === env.variables) return results;
  try {
    await saveEnvironment(w, ctx.host, { ...env, variables });
  } catch (err) {
    return fail(`The environment could not be saved: ${(err as Error).message}`);
  }
  return results;
}

/**
 * An OAuth 2.0 request with its token in place: a bearer (or the header prefix the auth sets). The UI
 * signs in when it has to; agents get a cached, refreshed or client credentials token only. With
 * `optional` a request whose token cannot be had without a sign-in goes without auth (curl export).
 */
async function applyOAuth(ctx: CommandContext, request: ApiRequest, mode: 'send' | 'optional'): Promise<ApiRequest> {
  if (request.auth.type !== 'oauth2') return request;
  const auth = request.auth;
  let accessToken: string;
  try {
    accessToken = (await getOAuthToken(ws(ctx), ctx.host, auth, { interactive: mode === 'send' && ctx.caller === 'ui' })).token.accessToken;
  } catch (err) {
    if (mode === 'optional') return { ...request, auth: { type: 'none' } };
    throw err;
  }
  const prefix = auth.headerPrefix?.trim() || 'Bearer';
  return {
    ...request,
    auth: prefix.toLowerCase() === 'bearer' ? { type: 'bearer', token: accessToken } : { type: 'apikey', key: 'Authorization', value: `${prefix} ${accessToken}`, in: 'header' },
  };
}

/** Secrets are masked for agents everywhere, so an error that names the URL it failed on must not carry them either. */
function errorForAgent(err: unknown, secrets: RedactUrlOptions): unknown {
  if (!(err instanceof QuiverError)) return err;
  const details = err.details as { url?: unknown } | undefined;
  return new QuiverError(err.code, scrubSecrets(err.message, secrets.values), details && typeof details.url === 'string' ? { ...details, url: redactUrl(details.url, secrets) } : err.details);
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
  description:
    'Returns one saved request by id. With `effective: true` it also returns `effective`: the request as it will be sent, with the headers, auth and base URL its collections add and `inherit` auth resolved, before variables (credentials typed into it are masked for agents).',
  scope: 'workspace',
  input: z.object({ id: z.string(), effective: z.boolean().optional() }),
  handler: async ({ id, effective }, ctx) => {
    const request = await requireRequest(ws(ctx), id);
    if (!effective) return request;
    const sent = await withInheritance(ws(ctx), request);
    return { ...request, effective: ctx.caller === 'mcp' ? redactRequest(sent) : sent };
  },
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
    body: RequestBodySchema.optional().describe('Initial body, e.g. { type: "graphql", query: "", variables: "" }'),
  }),
  handler: async (input, ctx) => {
    const req = newApiRequest({
      name: input.name ?? 'New request',
      method: input.method ?? 'GET',
      url: input.url ?? '',
      collectionId: input.collectionId ?? null,
      body: input.body ?? { type: 'none' },
      // Inside a collection a new request takes the collection's auth until it sets its own.
      auth: input.collectionId ? { type: 'inherit' } : { type: 'none' },
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
    'Sends an HTTP request and returns status, headers, body and timings. Pass a saved requestId or an inline request. A request\'s `capture` entries write values from the response (a JSON path into the body, a header, a cookie, the status) into the environment; `captured` reports each, secret ones masked for agents. Variables like {{baseUrl}} resolve from global variables and the active (or given) environment. Send options are the defaults, then the request\'s own `options`, then the `options` given here. Pass a `sendId` to be able to stop the send with api.request.cancel. For agents, the credentials and secret variables in `sent` (what went on the wire) are masked.',
  scope: 'workspace',
  input: z.object({
    requestId: z.string().optional(),
    request: ApiRequestSchema.optional(),
    environmentId: z.string().nullable().optional(),
    options: RequestOptionsSchema.optional().describe('Overrides for this send only: timeoutMs, followRedirects, insecure, maxBodyBytes'),
    /** Record the call in workspace history. Defaults to true. */
    record: z.boolean().optional(),
    sendId: z.string().min(1).max(100).optional().describe('Any id of your choosing; api.request.cancel with the same id stops this send'),
  }),
  handler: async (input, ctx): Promise<ApiResponse> => {
    const w = ws(ctx);
    const request = input.request ?? (input.requestId ? await requireRequest(w, input.requestId) : null);
    if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
    const options = effectiveSendOptions(request.options, input.options);
    const { resolved } = await resolveRequest(ctx, request, input.environmentId);
    const sendable = await applyOAuth(ctx, resolved, 'send');
    const prepared = await prepareRequest(sendable, { baseDir: w.path, agent: ctx.caller === 'mcp' });
    // Known before sending, so a failed send is recorded just as carefully; an OAuth token too.
    const secrets = await knownSecrets(ctx, resolved, input.environmentId);
    secrets.values = [...(secrets.values ?? []), ...requestSecretValues(sendable)];
    const forAgent = ctx.caller === 'mcp';

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
    const key = input.sendId ? inflightKey(w, input.sendId) : null;
    if (key && inflight.has(key)) throw new QuiverError('INVALID_INPUT', `A send with id ${input.sendId} is already running`);
    const controller = new AbortController();
    if (key) inflight.set(key, controller);
    try {
      // The cookie jar, unless the request or the call turns it off: cookies go out on every hop and answers' cookies are kept.
      const jar = options.cookies ? jarSession(await readJar(w)) : null;
      const response = await sendPrepared(prepared, options, controller.signal, jar?.hooks);
      if (jar) {
        response.cookieJar = jar.report;
        if (jar.changed()) await writeJar(w, ctx.host, jar.jar());
      }
      entry.status = response.status;
      entry.durationMs = Math.round(response.timings.total);
      const captured = await runCaptures(ctx, request, response, input.environmentId);
      if (captured) response.captured = captured;
      // The response is the server's own; `sent` and the final URL are what Quiver adds, with the secrets resolved into them.
      if (!forAgent) return response;
      // Each hop's URL is one Quiver sent, so it can carry a secret the request resolved to, like `sent`.
      const redirects = response.redirects.map((hop) => ({ ...hop, url: redactUrl(hop.url, secrets), location: redactUrl(hop.location, secrets) }));
      const maskedCaptures = response.captured?.map((c) => (c.secret && c.value !== null ? { ...c, value: REDACTED } : c));
      return { ...response, url: redactUrl(response.url, secrets), redirects, sent: redactSent(response.sent, secrets), ...(maskedCaptures ? { captured: maskedCaptures } : {}) };
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      throw forAgent ? errorForAgent(err, secrets) : err;
    } finally {
      if (key) inflight.delete(key);
      if (input.record !== false) {
        await historyReady.get(w.id);
        // The log is a plain file: credentials typed into the request, and secrets the URL resolved to, are masked before they reach it.
        await w.store.appendLog(HISTORY_LOG, redactHistoryEntry(entry, secrets));
        ctx.host.emit('store.changed', { workspaceId: w.id, collection: HISTORY_LOG });
      }
    }
  },
});

/** Sends that were given a sendId, by workspace and id, so api.request.cancel can stop them. */
const inflight = new Map<string, AbortController>();

function inflightKey(w: WorkspaceApi, sendId: string): string {
  return `${w.id}\u0000${sendId}`;
}

const requestCancel = defineCommand({
  id: 'api.request.cancel',
  title: 'Cancel API request',
  description:
    'Stops a running api.request.send that was given this sendId. The send fails with REQUEST_CANCELLED and its history entry says Cancelled. Returns whether a running send was found.',
  scope: 'workspace',
  input: z.object({ sendId: z.string().min(1).max(100) }),
  handler: async ({ sendId }, ctx) => {
    const controller = inflight.get(inflightKey(ws(ctx), sendId));
    controller?.abort();
    return { cancelled: Boolean(controller) };
  },
});

const responseSave = defineCommand({
  id: 'api.response.save',
  title: 'Save response body',
  description:
    'Writes a response body to a file: a utf8 body as text, a base64 body (binary responses) as its bytes. `path` is relative to the workspace or absolute; agents may only write inside the workspace folder. Missing folders are created and an existing file is replaced.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ path: z.string().min(1), body: z.string(), bodyEncoding: z.enum(['utf8', 'base64']).default('utf8') }),
  handler: async ({ path: target, body, bodyEncoding }, ctx) => {
    const w = ws(ctx);
    const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(w.path, target);
    if (ctx.caller === 'mcp') {
      const back = path.relative(w.path, abs);
      if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new QuiverError('INVALID_INPUT', 'Agents may only save inside the project folder');
    }
    const data = Buffer.from(body, bodyEncoding === 'base64' ? 'base64' : 'utf8');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    return { path: abs, bytes: data.length };
  },
});

// ---------- OAuth 2.0 ----------

const OAuthRefInput = z.object({
  requestId: z.string().optional().describe('A saved request whose auth (its own or inherited) is OAuth 2.0'),
  collectionId: z.string().optional().describe('A collection whose auth (its own or inherited) is OAuth 2.0'),
  auth: OAuth2AuthSchema.optional().describe('An OAuth 2.0 auth given directly'),
  environmentId: z.string().nullable().optional(),
});

/** The OAuth 2.0 auth a request, a collection or the input names, with variables resolved. */
async function oauthFor(ctx: CommandContext, input: z.infer<typeof OAuthRefInput>) {
  const w = ws(ctx);
  let auth: ApiAuth | undefined = input.auth;
  if (!auth && input.requestId) auth = (await withInheritance(w, await requireRequest(w, input.requestId))).auth;
  if (!auth && input.collectionId) {
    const collections = await listCollections(w);
    const col = collections.find((c) => c.id === input.collectionId);
    if (!col) throw new QuiverError('NOT_FOUND', `Collection ${input.collectionId} not found`);
    auth = resolveAuth(col.auth, collections, col.parentId);
  }
  if (!auth) throw new QuiverError('INVALID_INPUT', 'Provide requestId, collectionId or auth');
  if (auth.type !== 'oauth2') throw new QuiverError('INVALID_INPUT', `That auth is ${auth.type}, not OAuth 2.0`);
  const vars = await resolveVariableMap(w, ctx.host, input.environmentId);
  const resolved = resolveDeep(auth, vars);
  const missing = findUnresolved(JSON.stringify(resolved), vars);
  if (missing.length) throw new QuiverError('UNRESOLVED_VARIABLES', `Unresolved variables: ${missing.join(', ')}`, { missing });
  return resolved;
}

const oauthToken = defineCommand({
  id: 'api.oauth2.token',
  title: 'Get an OAuth 2.0 token',
  description:
    'Gets the token an OAuth 2.0 auth uses (a request\'s, a collection\'s or one given): the cached one while fresh, else a refresh, else a new one by client credentials. The authorization code grant needs a sign-in in the Quiver window, which agents cannot do: they get SIGN_IN_REQUIRED unless a token is cached or can be refreshed. The token is masked for agents. `force` skips the cache.',
  scope: 'workspace',
  input: OAuthRefInput.extend({ force: z.boolean().optional() }),
  handler: async (input, ctx) => {
    const auth = await oauthFor(ctx, input);
    const { token, source } = await getOAuthToken(ws(ctx), ctx.host, auth, { interactive: ctx.caller === 'ui', force: input.force });
    return {
      source,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
      scope: token.scope ?? null,
      refreshable: Boolean(token.refreshToken),
      token: ctx.caller === 'mcp' ? REDACTED : token.accessToken,
    };
  },
});

const oauthStatusCommand = defineCommand({
  id: 'api.oauth2.status',
  title: 'OAuth 2.0 token status',
  description: 'Whether a token is cached for an OAuth 2.0 auth, when it expires and whether it can be refreshed, without asking the server.',
  scope: 'workspace',
  input: OAuthRefInput,
  handler: async (input, ctx) => oauthStatus(ws(ctx), ctx.host, await oauthFor(ctx, input)),
});

const oauthClear = defineCommand({
  id: 'api.oauth2.clear',
  title: 'Forget an OAuth 2.0 token',
  description: 'Forgets the cached token of an OAuth 2.0 auth and the session of its sign-in window, so the next token is got again.',
  scope: 'workspace',
  input: OAuthRefInput,
  handler: async (input, ctx) => {
    await clearOAuthToken(ws(ctx), ctx.host, await oauthFor(ctx, input));
    return { cleared: true };
  },
});

// ---------- cookie jar ----------

function jarForCaller(ctx: CommandContext, jar: JarCookie[]): JarCookie[] {
  return ctx.caller === 'mcp' ? jar.map((c) => ({ ...c, value: REDACTED })) : jar;
}

const cookieList = defineCommand({
  id: 'api.cookie.list',
  title: 'List cookies',
  description:
    'The cookies in the workspace cookie jar (kept on this machine), sorted by domain, path and name; with `url`, only those a request to it carries, in the order they are sent. Values are masked for agents.',
  scope: 'workspace',
  input: z.object({ url: z.string().optional() }),
  handler: async ({ url }, ctx) => {
    const jar = await readJar(ws(ctx));
    const list = url ? cookiesFor(jar, url, Date.now()) : [...jar].sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    return jarForCaller(ctx, list);
  },
});

const cookieSet = defineCommand({
  id: 'api.cookie.set',
  title: 'Set a cookie',
  description: 'Puts a cookie in the jar as if a response to `url` had set it: `cookie` is a Set-Cookie value such as "sid=abc; Path=/; Max-Age=3600". Max-Age=0 deletes it.',
  scope: 'workspace',
  input: z.object({ url: z.string().min(1), cookie: z.string().min(1) }),
  handler: async ({ url, cookie }, ctx) => {
    const w = ws(ctx);
    const result = storeCookies(await readJar(w), url, [cookie], Date.now());
    if (result.rejected.length) throw new QuiverError('INVALID_INPUT', result.rejected[0].reason);
    if (!result.stored.length && !result.deleted.length) throw new QuiverError('INVALID_INPUT', `"${cookie}" is not a cookie (name=value) or ${url} is not a URL`);
    await writeJar(w, ctx.host, result.jar);
    return { stored: result.stored, deleted: result.deleted };
  },
});

const cookieDelete = defineCommand({
  id: 'api.cookie.delete',
  title: 'Delete a cookie',
  description: 'Removes one cookie from the jar by its domain, path and name.',
  scope: 'workspace',
  mutating: true,
  input: z.object({ domain: z.string(), path: z.string(), name: z.string() }),
  handler: async ({ domain, path: cookiePath, name }, ctx) => {
    const w = ws(ctx);
    const jar = await readJar(w);
    const kept = jar.filter((c) => !(c.domain === domain.toLowerCase() && c.path === cookiePath && c.name === name));
    if (kept.length !== jar.length) await writeJar(w, ctx.host, kept);
    return { deleted: jar.length - kept.length };
  },
});

const cookieClear = defineCommand({
  id: 'api.cookie.clear',
  title: 'Clear the cookie jar',
  description: 'Removes every cookie from the jar, or those of one domain (and its subdomains).',
  scope: 'workspace',
  mutating: true,
  input: z.object({ domain: z.string().optional() }),
  handler: async ({ domain }, ctx) => {
    const w = ws(ctx);
    const jar = await readJar(w);
    const d = domain?.trim().toLowerCase().replace(/^\./, '');
    const kept = d ? jar.filter((c) => c.domain !== d && !c.domain.endsWith(`.${d}`)) : [];
    await writeJar(w, ctx.host, kept);
    return { cleared: jar.length - kept.length };
  },
});

// ---------- GraphQL ----------

const RequestRefInput = z.object({
  requestId: z.string().optional(),
  request: ApiRequestSchema.optional(),
  environmentId: z.string().nullable().optional(),
});

async function requestFrom(ctx: CommandContext, input: { requestId?: string; request?: ApiRequest }): Promise<ApiRequest> {
  const request = input.request ?? (input.requestId ? await requireRequest(ws(ctx), input.requestId) : null);
  if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
  return request;
}

const graphqlIntrospect = defineCommand({
  id: 'api.graphql.introspect',
  title: 'Fetch GraphQL schema',
  description:
    'Runs the introspection query against the URL of a request (saved id or inline) with its headers and auth, and caches the schema as SDL on this machine for autocompletion, the schema explorer and api.graphql.schema. Returns the SDL.',
  scope: 'workspace',
  input: RequestRefInput,
  handler: async (input, ctx) => {
    const request = await requestFrom(ctx, input);
    const { resolved: written } = await resolveRequest(ctx, request, input.environmentId);
    const resolved = await applyOAuth(ctx, written, 'send');
    if (ctx.caller !== 'mcp') return introspect(ws(ctx), resolved);
    const secrets = await knownSecrets(ctx, written, input.environmentId);
    secrets.values = [...(secrets.values ?? []), ...requestSecretValues(resolved)];
    try {
      const doc = await introspect(ws(ctx), resolved);
      return { ...doc, url: redactUrl(doc.url, secrets) };
    } catch (err) {
      throw errorForAgent(err, secrets);
    }
  },
});

const graphqlSchema = defineCommand({
  id: 'api.graphql.schema',
  title: 'GraphQL schema',
  description: 'Returns the cached schema (SDL) of the endpoint of a request, or null when it was never fetched with api.graphql.introspect. Pass `url` to look an endpoint up directly.',
  scope: 'workspace',
  input: RequestRefInput.extend({ url: z.string().optional() }),
  handler: async (input, ctx) => {
    if (input.url) return readSchema(ws(ctx), graphqlEndpoint(input.url));
    const request = await requestFrom(ctx, input);
    const vars = await resolveVariableMap(ws(ctx), ctx.host, input.environmentId);
    const resolved = resolveDeep(await withInheritance(ws(ctx), request), vars);
    const doc = await readSchema(ws(ctx), graphqlEndpoint((await prepareRequest(resolved)).url));
    return doc && ctx.caller === 'mcp' ? { ...doc, url: redactUrl(doc.url, await knownSecrets(ctx, resolved, input.environmentId)) } : doc;
  },
});

// ---------- collections ----------

const collectionList = defineCommand({
  id: 'api.collection.list',
  title: 'List API collections',
  description: 'Lists request collections (folders) with what they pass on to the requests inside: base URL, headers and auth.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => (await listCollections(ws(ctx))).sort((a, b) => a.name.localeCompare(b.name)),
});

const collectionGet = defineCommand({
  id: 'api.collection.get',
  title: 'Get API collection',
  description: 'Returns one collection by id, with its base URL, headers, auth and description.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const col = (await listCollections(ws(ctx))).find((c) => c.id === id);
    if (!col) throw new QuiverError('NOT_FOUND', `Collection ${id} not found`);
    return col;
  },
});

const collectionSave = defineCommand({
  id: 'api.collection.save',
  title: 'Save API collection',
  description:
    'Saves a collection: name, parent, and what the requests inside inherit. `baseUrl` prefixes request URLs that start with "/" (the nearest non-empty one wins); `headers` are sent below those of the collections above, a request\'s own header of the same name winning; `auth` is used by requests whose auth is `inherit` (`inherit` here passes on the parent\'s).',
  scope: 'workspace',
  input: z.object({ collection: ApiCollectionSchema }),
  handler: async ({ collection }, ctx) => {
    const w = ws(ctx);
    const collections = await listCollections(w);
    const parentId = collection.parentId ?? null;
    if (parentId !== null && !collections.some((c) => c.id === parentId)) throw new QuiverError('NOT_FOUND', `Collection ${parentId} not found`);
    if (!canMoveCollection(collections, collection.id, parentId)) throw new QuiverError('INVALID_INPUT', `"${collection.name}" cannot go inside itself or one of its own sub-collections`);
    return w.store.put(COLLECTIONS.collections, { ...collection, parentId });
  },
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

const collectionMove = defineCommand({
  id: 'api.collection.move',
  title: 'Move API collection',
  description: 'Moves a collection, with everything inside it, under another collection (parentId null for the root). A move into itself or one of its own sub-collections is refused.',
  scope: 'workspace',
  input: z.object({ id: z.string(), parentId: z.string().nullable() }),
  handler: async ({ id, parentId }, ctx) => {
    const w = ws(ctx);
    const collections = await w.store.list<ApiCollection>(COLLECTIONS.collections);
    const col = collections.find((c) => c.id === id);
    if (!col) throw new QuiverError('NOT_FOUND', `Collection ${id} not found`);
    if (parentId !== null && !collections.some((c) => c.id === parentId)) throw new QuiverError('NOT_FOUND', `Collection ${parentId} not found`);
    if (!canMoveCollection(collections, id, parentId)) throw new QuiverError('INVALID_INPUT', `"${col.name}" cannot go inside itself or one of its own sub-collections`);
    return w.store.put(COLLECTIONS.collections, { ...col, parentId });
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

const variablesList = defineCommand({
  id: 'api.variables.list',
  title: 'List variables in effect',
  description: 'Lists every {{variable}} a request can use right now: global variables, then the active environment (which wins), then the built-in dynamic ones, each with its source. Secret values are masked for agents.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => listResolvedVariables(ws(ctx), ctx.host, ctx.caller === 'mcp'),
});

const variablesSet = defineCommand({
  id: 'api.variables.set',
  title: 'Set a variable value',
  description: 'Changes the value {{name}} resolves to, where it is defined: the active environment (secrets stay encrypted on this machine) or else the global variables. Does not create variables. Changing a global variable needs mutations enabled, since every workspace sees it.',
  scope: 'workspace',
  mutating: async ({ name }, ctx) => (await variableSource(ws(ctx), ctx.host, name)) !== 'environment',
  input: z.object({ name: z.string().min(1), value: z.string() }),
  handler: async ({ name, value }, ctx) => setResolvedVariable(ws(ctx), ctx.host, name, value),
});

const variablesDefine = defineCommand({
  id: 'api.variables.define',
  title: 'Define a variable',
  description: 'Gives {{name}} a value in a chosen environment (optionally secret, stored encrypted on this machine) or in the global variables. Updates the definition already there instead of adding a duplicate. Writing a global variable needs mutations enabled, since every workspace sees it.',
  scope: 'workspace',
  mutating: ({ target }) => target.kind === 'global',
  input: z.object({
    name: z.string().regex(DEFINABLE_VARIABLE_NAME, 'Use letters, digits, _, . and -, starting with a letter or _'),
    value: z.string(),
    target: z.discriminatedUnion('kind', [z.object({ kind: z.literal('environment'), id: z.string() }), z.object({ kind: z.literal('global') })]),
    secret: z.boolean().optional(),
  }),
  handler: async ({ name, value, target, secret }, ctx) => defineVariable(ws(ctx), ctx.host, name, value, target, secret),
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
  description: 'Most recent sent requests with status and timing. Tokens, passwords and API keys in them are masked; {{variable}} references are kept.',
  scope: 'workspace',
  input: z.object({ limit: z.number().int().min(1).max(500).default(50) }),
  handler: async ({ limit }, ctx) => {
    await historyReady.get(ws(ctx).id);
    return (await ws(ctx).store.readLog<HistoryEntry>(HISTORY_LOG, limit)).map((entry) => redactHistoryEntry(entry));
  },
});

const historyClear = defineCommand({
  id: 'api.history.clear',
  title: 'Clear request history',
  description: 'Clears the request history for this workspace.',
  scope: 'workspace',
  mutating: true,
  input: z.object({}),
  handler: async (_i, ctx) => {
    await historyReady.get(ws(ctx).id);
    await ws(ctx).store.clearLog(HISTORY_LOG);
    ctx.host.emit('store.changed', { workspaceId: ws(ctx).id, collection: HISTORY_LOG });
    return { cleared: true };
  },
});

// ---------- import / export ----------

const importCurl = defineCommand({
  id: 'api.import.curl',
  title: 'Import from curl',
  description:
    'Parses a curl command and saves it as a request. The command is read with the quoting rules of the shell it was copied for: bash/zsh, cmd.exe (Chrome\'s "Copy as cURL (cmd)") or PowerShell, detected from the text unless `dialect` says. A command that cannot be imported exactly is refused and nothing is saved.',
  scope: 'workspace',
  input: z.object({
    command: z.string().min(4),
    collectionId: z.string().nullable().optional(),
    name: z.string().optional(),
    dialect: z.enum(['auto', 'posix', 'cmd', 'powershell']).optional().describe('Shell the command was written for; auto (the default) detects it.'),
  }),
  handler: async ({ command, collectionId, name, dialect }, ctx) => {
    let parsed: ApiRequest;
    try {
      parsed = parseCurl(command, { dialect });
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
  description: 'Renders a request as a curl command with variables resolved. For agents, credentials and secret variables are masked in it.',
  scope: 'workspace',
  input: z.object({ requestId: z.string().optional(), request: ApiRequestSchema.optional(), environmentId: z.string().nullable().optional() }),
  handler: async (input, ctx) => {
    const request = input.request ?? (input.requestId ? await requireRequest(ws(ctx), input.requestId) : null);
    if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
    const vars = await resolveVariableMap(ws(ctx), ctx.host, input.environmentId);
    const written = resolveDeep(await withInheritance(ws(ctx), request), vars);
    // A cached or client credentials token goes in the command; a sign-in is never opened for a copy.
    const resolved = await applyOAuth(ctx, written, 'optional');
    const prepared = await prepareRequest(resolved);
    const form: CurlFormField[] | undefined =
      resolved.body.type === 'form'
        ? resolved.body.fields
            .filter((f) => f.enabled && f.key.trim())
            .map((f) => (f.kind === 'file' ? { name: f.key.trim(), file: f.value.trim(), type: f.contentType?.trim() || undefined, fileName: f.fileName?.trim() || undefined } : ([f.key, f.value] as [string, string])))
        : undefined;
    const bodyFile = resolved.body.type === 'binary' ? resolved.body.path.trim() : undefined;
    const body = typeof prepared.body === 'string' ? prepared.body : null;
    // A command an agent asks for is one it reads, not one the user pastes into a terminal.
    const wire = { method: prepared.method, url: prepared.url, headers: prepared.headers, bodyPreview: body };
    const shown = ctx.caller === 'mcp' ? redactSent(wire, await knownSecrets(ctx, resolved, input.environmentId)) : wire;
    return {
      command: toCurl({
        method: shown.method,
        url: shown.url,
        headers: form ? shown.headers.filter(([k]) => k.toLowerCase() !== 'content-type') : shown.headers,
        body: shown.bodyPreview,
        bodyType: form ? 'form' : 'raw',
        formFields: form,
        bodyFile,
        // curl's own defaults differ from Quiver's: it follows no redirects and has no time limit, so say what this request does.
        options: { ...effectiveSendOptions(request.options), timeoutMs: request.options?.timeoutMs },
      }),
    };
  },
});

const fileStat = defineCommand({
  id: 'api.file.stat',
  title: 'Look up a file for a request',
  description: 'Resolves a file path the way a request body does (relative to the workspace), with its size, and the path relative to the workspace when the file is inside it.',
  scope: 'workspace',
  hidden: true,
  input: z.object({ path: z.string() }),
  handler: async ({ path: given }, ctx) => {
    const w = ws(ctx);
    const trimmed = given.trim();
    if (!trimmed) return { exists: false, size: null, relative: null, abs: null };
    const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(w.path, trimmed);
    const back = path.relative(w.path, abs);
    const inside = Boolean(back) && !back.startsWith('..') && !path.isAbsolute(back);
    const stat = await fs.stat(abs).catch(() => null);
    return { exists: Boolean(stat?.isFile()), size: stat?.isFile() ? stat.size : null, relative: inside ? back.split(path.sep).join('/') : null, abs };
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
  onWorkspaceOpen: (w) => {
    historyReady.set(
      w.id,
      scrubHistory(w).catch((err) => console.warn(`[quiver] could not mask credentials in the request history of ${w.path}: ${(err as Error).message}`)),
    );
  },
  onWorkspaceClose: (w) => {
    historyReady.delete(w.id);
  },
  commands: [
    requestList,
    requestGet,
    requestCreate,
    requestSave,
    requestDuplicate,
    requestMove,
    requestDelete,
    requestSend,
    requestCancel,
    responseSave,
    cookieList,
    cookieSet,
    cookieDelete,
    cookieClear,
    oauthToken,
    oauthStatusCommand,
    oauthClear,
    graphqlIntrospect,
    graphqlSchema,
    collectionList,
    collectionGet,
    collectionSave,
    collectionCreate,
    collectionRename,
    collectionMove,
    collectionDelete,
    environmentList,
    environmentGet,
    environmentCreate,
    environmentSave,
    environmentDelete,
    environmentActive,
    environmentSetActive,
    variablesList,
    variablesSet,
    variablesDefine,
    historyList,
    historyClear,
    importCurl,
    exportCurl,
    fileStat,
    suggestName,
  ],
});
