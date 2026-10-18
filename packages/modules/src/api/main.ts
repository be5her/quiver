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
  captureIsSecret,
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
  isSecretName,
  parseCurl,
  redactHistoryEntry,
  redactLiteral,
  redactRequest,
  redactSent,
  redactUrl,
  requestSecretValues,
  resolveDeep,
  scrubCheckResults,
  scrubResponse,
  scrubSecrets,
  toCode,
  CODE_TARGETS,
  type ClientCertificate,
  type NetworkConfig,
  toHistoryResponse,
  pruneHistory,
  createLineSplitter,
  createSseParser,
  MAX_STREAM_LINE_BYTES,
  type StreamItem,
  type StreamKind,
  type StreamRead,
  checkSummary,
  evaluateChecks,
  resolveTemplate,
  runOrder,
  type ApiRun,
  ImportError,
  importHar,
  importInsomnia,
  importOpenApi,
  importPostman,
  type ImportResult,
  type ApiCollection,
  type ApiRequest,
  type ApiAuth,
  type OAuth2Auth,
  type JarCookie,
  type ApiResponse,
  type CapturedValue,
  type CodeBody,
  type CodeInput,
  type CodeTarget,
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
import { jarSession, readJar, updateJar } from './cookies';
import { CERTIFICATES_DOC, networkConfig, readCertificates, resolveNetwork, type NetworkContext } from './network';
import { agentPath } from './paths';

const HISTORY_LOG = 'history';

/**
 * History written before credentials were masked still holds them in plain text, so the log is
 * tidied once when its workspace opens. Reads and appends wait for that, so nothing is lost or reordered.
 */
const historyReady = new Map<string, Promise<void>>();

/** Appends and rewrites of a workspace's history, one after another: a tidy never loses an entry appended meanwhile. */
const historyWrites = new Map<string, Promise<void>>();

function withHistory(w: WorkspaceApi, write: () => Promise<void>): Promise<void> {
  const next = (historyWrites.get(w.id) ?? Promise.resolve()).catch(() => undefined).then(write);
  historyWrites.set(w.id, next);
  return next.finally(() => {
    if (historyWrites.get(w.id) === next) historyWrites.delete(w.id);
  });
}

/** Resolves once the tidy at open and every write under way (an append, or the tidy every fifty sends) are done, so a read sees the log whole and up to date. */
async function historySettled(w: WorkspaceApi): Promise<void> {
  await historyReady.get(w.id);
  await historyWrites.get(w.id)?.catch(() => undefined);
}

/** The log is tidied after this many appends, so it never grows far past what `pruneHistory` keeps. */
const TIDY_EVERY = 50;
const appendsSinceTidy = new Map<string, number>();

/**
 * Rewrite the log when it needs it: entries from before credentials were masked get masked, and it
 * is pruned to the newest entries, responses kept on the newest of those (`pruneHistory`), so the
 * file stays quick to read and a kept body does not sit on disk for ever.
 */
async function tidyHistory(w: WorkspaceApi): Promise<void> {
  const entries = await w.store.readLog<HistoryEntry>(HISTORY_LOG, Number.MAX_SAFE_INTEGER);
  const pruned = pruneHistory(entries.map((entry) => redactHistoryEntry(entry)));
  if (!pruned.changed && JSON.stringify(pruned.entries) === JSON.stringify(entries)) return;
  // One rename puts the tidied log in place: a crash midway leaves the old log whole, and a listing meanwhile reads one or the other.
  await w.store.writeLog(HISTORY_LOG, [...pruned.entries].reverse());
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

interface CaptureOutcome {
  captured: CapturedValue[];
  /** The values secret captures read, written or not: credentials to mask wherever the send is written down. */
  secrets: string[];
}

/**
 * Run a request's captures on its response and write what they read into the environment (the given
 * one, else the active one) in a single save. A capture that reads nothing, or a send without an
 * environment, is reported as failed and the send still succeeds. An existing secret stays secret.
 */
async function runCaptures(ctx: CommandContext, request: ApiRequest, response: ApiResponse, environmentId?: string | null): Promise<CaptureOutcome | undefined> {
  const captures = (request.capture ?? []).filter((c) => c.enabled && c.variable.trim());
  if (!captures.length) return undefined;
  const w = ws(ctx);
  const envId = environmentId === undefined ? await getActiveEnvironmentId(w) : environmentId;
  const env = envId ? await getEnvironment(w, ctx.host, envId) : undefined;
  const results: CapturedValue[] = captures.map((capture) => {
    const variable = capture.variable.trim();
    // Marked secret, named like a credential, or already secret in the environment: never in the committed file.
    const secret = captureIsSecret(capture, env?.variables);
    const read = extractCapture(capture, response);
    return read.ok ? { variable, value: read.value, ok: true, secret } : { variable, value: null, ok: false, error: read.error, secret };
  });
  const secretsRead = results.filter((r) => r.ok && r.secret && r.value !== null).map((r) => r.value as string);
  const done = (captured: CapturedValue[]): CaptureOutcome => ({ captured, secrets: secretsRead });
  const fail = (error: string) => done(results.map((r) => (r.ok ? { ...r, value: null, ok: false, error } : r)));
  if (!env) return fail('No environment is active, so there is nowhere to write it');
  let variables = env.variables;
  for (const r of results) {
    if (r.ok && r.value !== null) variables = defineVariableIn(variables, r.variable, r.value, newId(), r.secret);
  }
  if (variables === env.variables) return done(results);
  try {
    await saveEnvironment(w, ctx.host, { ...env, variables });
  } catch (err) {
    return fail(`The environment could not be saved: ${(err as Error).message}`);
  }
  return done(results);
}

/**
 * An OAuth 2.0 request with its token in place: a bearer (or the header prefix the auth sets). The UI
 * signs in when it has to; agents get a cached, refreshed or client credentials token only. With
 * `optional` a request whose token cannot be had without a sign-in goes without auth (curl export).
 * The token URL is reached as the request is: through `network` and with the request's TLS choice.
 */
async function applyOAuth(ctx: CommandContext, request: ApiRequest, mode: 'send' | 'optional', network: NetworkContext): Promise<ApiRequest> {
  if (request.auth.type !== 'oauth2') return request;
  const auth = request.auth;
  let accessToken: string;
  try {
    const { insecure } = effectiveSendOptions(request.options);
    accessToken = (await getOAuthToken(ws(ctx), ctx.host, auth, { interactive: mode === 'send' && ctx.caller === 'ui', insecure, network })).token.accessToken;
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

const SendInput = z.object({
  requestId: z.string().optional(),
  request: ApiRequestSchema.optional(),
  environmentId: z.string().nullable().optional(),
  options: RequestOptionsSchema.optional().describe('Overrides for this send only: timeoutMs, followRedirects, insecure, maxBodyBytes'),
  /** Record the call in workspace history. Defaults to true. */
  record: z.boolean().optional(),
  sendId: z.string().min(1).max(100).optional().describe('Any id of your choosing; api.request.cancel with the same id stops this send'),
  stream: z.boolean().optional().describe('Read the body as a live stream of lines (NDJSON); an event stream streams without it. Shorthand for options.stream.'),
});

/**
 * Send a request: resolve, apply OAuth, send through the cookie jar, run captures and checks, and
 * record it in the history. `signal` stops it from outside (a run being cancelled); `recorded` gets
 * the history entry as written, credentials masked, whether or not the send succeeded.
 */
/**
 * `streams` false reads every body whole (a collection run waits for an event stream to end, or times out).
 */
async function sendRequest(ctx: CommandContext, input: z.infer<typeof SendInput>, signal?: AbortSignal, recorded?: (entry: HistoryEntry, secretValues: string[]) => void, streams = true): Promise<ApiResponse> {
  const w = ws(ctx);
  const request = input.request ?? (input.requestId ? await requireRequest(w, input.requestId) : null);
  if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
  const options = effectiveSendOptions(request.options, { ...input.options, ...(input.stream !== undefined ? { stream: input.stream } : {}) });
  const { resolved, vars } = await resolveRequest(ctx, request, input.environmentId);
  // The proxy and client certificates, read once for the token request and every hop of the send.
  const network = await resolveNetwork(ctx.host, w);
  const sendable = await applyOAuth(ctx, resolved, 'send', network);
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
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  if (key) inflight.set(key, controller);
  try {
    // The cookie jar, unless the request or the call turns it off: cookies go out on every hop and answers' cookies are kept.
    const jar = options.cookies ? jarSession(await readJar(w, ctx.host)) : null;
    // A big download says how far it got (to the UI, which gives a sendId); a streamed body is handed to the stream registry.
    let streamId: string | undefined;
    const progress = input.sendId ? throttled(() => ctx.host.emit('api.changed', { workspaceId: w.id, reason: 'progress', sendId: input.sendId, received })) : null;
    let received = 0;
    const response = await sendPrepared(prepared, options, controller.signal, jar?.hooks, {
      onProgress: progress
        ? (bytes) => {
            received = bytes;
            progress.call();
          }
        : undefined,
      onStream: streams ? (kind, chunks) => (streamId = startStream(ctx, w.id, kind, chunks, controller)) : undefined,
    }, network);
    if (jar) {
      response.cookieJar = jar.report;
      // Applied to the jar as it is now, not the one read before the send: a send that finished meanwhile keeps its cookies.
      if (jar.changed()) await updateJar(w, ctx.host, (current) => jar.apply(current));
    }
    entry.status = response.status;
    entry.durationMs = Math.round(response.timings.total);
    // Each hop's URL is one Quiver sent, so it can carry a secret the request resolved to, like `sent`; its headers are scrubbed like the response's.
    const hopsForAgent = () => response.redirects.map((hop) => ({ ...hop, url: redactUrl(hop.url, secrets), location: redactUrl(hop.location, secrets), headers: scrubResponse({ headers: hop.headers, body: '', bodyEncoding: 'utf8' as const }, secrets).headers }));
    if (streamId) {
      // Captures and checks read a whole body; a stream has none yet.
      response.streamId = streamId;
      if (!forAgent) return response;
      return { ...scrubResponse(response, secrets), url: redactUrl(response.url, secrets), redirects: hopsForAgent(), sent: redactSent(response.sent, secrets) };
    }
    const captures = await runCaptures(ctx, request, response, input.environmentId);
    if (captures) {
      response.captured = captures.captured;
      // What a secret capture read is a credential now: masked wherever this send is written down or handed to an agent.
      secrets.values = [...(secrets.values ?? []), ...captures.secrets];
    }
    // Checks read the response as the server sent it; their expected values resolve with the variables the request was sent with.
    const checks = evaluateChecks(request.checks, response, (text) => resolveTemplate(text, vars));
    if (checks.length) {
      response.checks = checks;
      entry.checks = checkSummary(checks);
    }
    // The response goes into the history too, small ones and unless the workspace turned it off, to open or compare later.
    if (await w.getState<boolean>(KEEP_RESPONSES, true)) entry.response = toHistoryResponse(response, secrets.values ?? []);
    if (!forAgent) return response;
    // An agent gets the response with the known secrets scrubbed from its headers and body (a secret capture's value among them), as the history keeps it.
    const maskedCaptures = response.captured?.map((c) => (c.secret && c.value !== null ? { ...c, value: REDACTED } : c));
    return { ...scrubResponse(response, secrets), url: redactUrl(response.url, secrets), redirects: hopsForAgent(), sent: redactSent(response.sent, secrets), ...(maskedCaptures ? { captured: maskedCaptures } : {}) };
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    throw forAgent ? errorForAgent(err, secrets) : err;
  } finally {
    if (key) inflight.delete(key);
    // The log is a plain file: credentials typed into the request, and secrets the URL resolved to, are masked before they reach it.
    const masked = redactHistoryEntry(entry, secrets);
    // A run keeps more than the entry (check results); it gets the secrets to mask them the same way.
    recorded?.(masked, secrets.values ?? []);
    if (input.record !== false) {
      await historyReady.get(w.id);
      await withHistory(w, async () => {
        await w.store.appendLog(HISTORY_LOG, masked);
        const appends = (appendsSinceTidy.get(w.id) ?? 0) + 1;
        appendsSinceTidy.set(w.id, appends % TIDY_EVERY);
        if (appends % TIDY_EVERY === 0) await tidyHistory(w);
      });
      ctx.host.emit('store.changed', { workspaceId: w.id, collection: HISTORY_LOG });
    }
  }
}

const requestSend = defineCommand({
  id: 'api.request.send',
  title: 'Send API request',
  description:
    'Sends an HTTP request and returns status, headers, body and timings. Pass a saved requestId or an inline request. A request\'s `capture` entries write values from the response (a JSON path into the body, a header, a cookie, the status) into the environment; `captured` reports each, secret ones masked for agents. Variables like {{baseUrl}} resolve from global variables and the active (or given) environment. A request\'s `checks` (assertions on the status, a header, the body, a JSON path, the time or the size) are run on the response and reported in `checks`. Send options are the defaults, then the request\'s own `options`, then the `options` given here. Pass a `sendId` to be able to stop the send with api.request.cancel. For agents, the credentials and secret variables in `sent` (what went on the wire) are masked, and the same secrets (what a secret capture read among them) are scrubbed from the response\'s headers and body.',
  scope: 'workspace',
  input: SendInput,
  handler: (input, ctx) => sendRequest(ctx, input),
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
      // Links followed, so a junction inside the project cannot lead the write out of it; .git and .quiver/local refused.
      const placed = await agentPath(w.path, target, { writing: true });
      if (placed.refused) throw new QuiverError('INVALID_INPUT', `Agents may only save inside the project folder: ${placed.refused}`);
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

/** The OAuth 2.0 auth a request, a collection or the input names, with variables resolved, and whether the request accepts invalid certificates. */
async function oauthFor(ctx: CommandContext, input: z.infer<typeof OAuthRefInput>): Promise<{ auth: OAuth2Auth; insecure: boolean }> {
  const w = ws(ctx);
  let auth: ApiAuth | undefined = input.auth;
  let insecure = false;
  if (!auth && input.requestId) {
    const request = await requireRequest(w, input.requestId);
    auth = (await withInheritance(w, request)).auth;
    insecure = effectiveSendOptions(request.options).insecure;
  }
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
  return { auth: resolved, insecure };
}

const oauthToken = defineCommand({
  id: 'api.oauth2.token',
  title: 'Get an OAuth 2.0 token',
  description:
    'Gets the token an OAuth 2.0 auth uses (a request\'s, a collection\'s or one given): the cached one while fresh, else a refresh, else a new one by client credentials. The authorization code grant needs a sign-in in the Quiver window, which agents cannot do: they get SIGN_IN_REQUIRED unless a token is cached or can be refreshed. The token is masked for agents. `force` skips the cache.',
  scope: 'workspace',
  input: OAuthRefInput.extend({ force: z.boolean().optional() }),
  handler: async (input, ctx) => {
    const { auth, insecure } = await oauthFor(ctx, input);
    const { token, source } = await getOAuthToken(ws(ctx), ctx.host, auth, { interactive: ctx.caller === 'ui', force: input.force, insecure, network: await resolveNetwork(ctx.host, ws(ctx)) });
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
  handler: async (input, ctx) => oauthStatus(ws(ctx), ctx.host, (await oauthFor(ctx, input)).auth),
});

const oauthClear = defineCommand({
  id: 'api.oauth2.clear',
  title: 'Forget an OAuth 2.0 token',
  description: 'Forgets the cached token of an OAuth 2.0 auth and the session of its sign-in window, so the next token is got again.',
  scope: 'workspace',
  input: OAuthRefInput,
  handler: async (input, ctx) => {
    await clearOAuthToken(ws(ctx), ctx.host, (await oauthFor(ctx, input)).auth);
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
    const jar = await readJar(ws(ctx), ctx.host);
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
    const probe = storeCookies(await readJar(w, ctx.host), url, [cookie], Date.now());
    if (probe.rejected.length) throw new QuiverError('INVALID_INPUT', probe.rejected[0].reason);
    if (!probe.stored.length && !probe.deleted.length) throw new QuiverError('INVALID_INPUT', `"${cookie}" is not a cookie (name=value) or ${url} is not a URL`);
    await updateJar(w, ctx.host, (jar) => storeCookies(jar, url, [cookie], Date.now()).jar);
    return { stored: probe.stored, deleted: probe.deleted };
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
    let deleted = 0;
    await updateJar(ws(ctx), ctx.host, (jar) => {
      const kept = jar.filter((c) => !(c.domain === domain.toLowerCase() && c.path === cookiePath && c.name === name));
      deleted = jar.length - kept.length;
      return deleted ? kept : null;
    });
    return { deleted };
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
    const d = domain?.trim().toLowerCase().replace(/^\./, '');
    let cleared = 0;
    await updateJar(ws(ctx), ctx.host, (jar) => {
      const kept = d ? jar.filter((c) => c.domain !== d && !c.domain.endsWith(`.${d}`)) : [];
      cleared = jar.length - kept.length;
      return kept;
    });
    return { cleared };
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
    const network = await resolveNetwork(ctx.host, ws(ctx));
    const resolved = await applyOAuth(ctx, written, 'send', network);
    if (ctx.caller !== 'mcp') return introspect(ws(ctx), resolved, network);
    const secrets = await knownSecrets(ctx, written, input.environmentId);
    secrets.values = [...(secrets.values ?? []), ...requestSecretValues(resolved)];
    try {
      const doc = await introspect(ws(ctx), resolved, network);
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

/** Workspace state: whether sends keep their response in the history (on unless turned off). */
const KEEP_RESPONSES = 'api.history.keepResponses';

const historyList = defineCommand({
  id: 'api.history.list',
  title: 'Request history',
  description:
    'Most recent sent requests with status and timing, optionally of one saved request. Responses of 256 KB or less are kept with their entry (Set-Cookie values and known secrets masked); they are left out of the listing (`hasResponse` says one is kept) unless withResponses is true, or read one entry with api.history.get. Tokens, passwords and API keys in requests are masked; {{variable}} references are kept.',
  scope: 'workspace',
  input: z.object({ limit: z.number().int().min(1).max(500).default(50), requestId: z.string().optional(), withResponses: z.boolean().optional() }),
  handler: async ({ limit, requestId, withResponses }, ctx) => {
    await historySettled(ws(ctx));
    // A filtered listing reads further back, so a request sent among many others still has its past.
    const entries = (await ws(ctx).store.readLog<HistoryEntry>(HISTORY_LOG, requestId ? 2000 : limit)).filter((e) => !requestId || e.requestId === requestId).slice(0, limit);
    return entries.map((entry) => {
      const masked = redactHistoryEntry(entry);
      if (withResponses || !masked.response) return masked;
      const { response: _kept, ...rest } = masked;
      return { ...rest, hasResponse: true };
    });
  },
});

const historyGet = defineCommand({
  id: 'api.history.get',
  title: 'Get a history entry',
  description: 'One history entry with its kept response, when it has one.',
  scope: 'workspace',
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    await historySettled(ws(ctx));
    const entry = (await ws(ctx).store.readLog<HistoryEntry>(HISTORY_LOG, 5000)).find((e) => e.id === id);
    if (!entry) throw new QuiverError('NOT_FOUND', `History entry ${id} not found`);
    return redactHistoryEntry(entry);
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
    await withHistory(ws(ctx), () => ws(ctx).store.clearLog(HISTORY_LOG));
    ctx.host.emit('store.changed', { workspaceId: ws(ctx).id, collection: HISTORY_LOG });
    return { cleared: true };
  },
});

// ---------- streamed responses ----------

/** Items kept per stream; older ones are dropped, and a read says how many it missed. */
const STREAM_BUFFER = 5000;
/** Bytes of items kept per stream, whatever their count: a stream of long lines drops older ones sooner. */
const STREAM_KEPT_BYTES = 16 * 1024 * 1024;
/** Streams open at once per workspace; past it the oldest is closed. */
const MAX_OPEN_STREAMS = 20;
/** Finished streams kept per workspace for reading; older ones are forgotten. */
const KEPT_STREAMS = 10;
/** At most one `api.changed` per stream (or download) this often. */
const ANNOUNCE_MS = 100;

interface LiveStream {
  id: string;
  workspaceId: string;
  kind: StreamKind;
  started: number;
  items: StreamItem[];
  nextSeq: number;
  dropped: number;
  done: boolean;
  error: string | null;
  bytes: number;
  /** The size of the items kept, for STREAM_KEPT_BYTES. */
  keptBytes: number;
  /** Why Quiver closed it, when it did (too many open at once); the error the read then reports. */
  stopReason: string | null;
  controller: AbortController;
}

const streams = new Map<string, LiveStream>();

/** Calls `fn` at most once per ANNOUNCE_MS, the last call always reaching it. */
function throttled(fn: () => void): { call(): void; flush(): void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  return {
    call() {
      if (timer) return;
      const wait = ANNOUNCE_MS - (Date.now() - last);
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      run();
    },
  };
}

/** Read a streamed body into items as it arrives, announcing new ones; returns the stream's id. */
function startStream(ctx: CommandContext, workspaceId: string, kind: StreamKind, chunks: AsyncGenerator<string>, controller: AbortController): string {
  // Too many open at once (an agent that never stops them): the oldest close, and their last read says why.
  const open = [...streams.values()].filter((s) => s.workspaceId === workspaceId && !s.done);
  for (const old of open.slice(0, Math.max(0, open.length - (MAX_OPEN_STREAMS - 1)))) {
    old.stopReason = `Stopped: more than ${MAX_OPEN_STREAMS} streams were open at once; stop the ones you are done with`;
    old.controller.abort();
  }
  const live: LiveStream = { id: newId(), workspaceId, kind, started: Date.now(), items: [], nextSeq: 0, dropped: 0, done: false, error: null, bytes: 0, keptBytes: 0, stopReason: null, controller };
  streams.set(live.id, live);
  const announce = throttled(() => ctx.host.emit('api.changed', { workspaceId, reason: 'stream', streamId: live.id }));
  const add = (items: Omit<StreamItem, 'seq' | 'at'>[]) => {
    if (!items.length) return;
    const at = Date.now() - live.started;
    for (const item of items) {
      live.items.push({ seq: live.nextSeq++, at, ...item });
      live.keptBytes += item.data.length;
    }
    while (live.items.length > STREAM_BUFFER || live.keptBytes > STREAM_KEPT_BYTES) live.keptBytes -= live.items.shift()!.data.length;
    announce.call();
  };
  // A line or event that never ends is not one to keep in memory: the parser throws, and the stream closes with that error.
  const sse = kind === 'sse' ? createSseParser({ maxEventBytes: MAX_STREAM_LINE_BYTES }) : null;
  const lines = kind === 'lines' ? createLineSplitter(MAX_STREAM_LINE_BYTES) : null;
  void (async () => {
    try {
      for await (const chunk of chunks) {
        live.bytes += Buffer.byteLength(chunk);
        if (sse) add(sse.push(chunk).map((e) => ({ event: e.event, id: e.id, data: e.data })));
        else add(lines!.push(chunk).map((data) => ({ data })));
      }
      if (lines) add(lines.end().map((data) => ({ data })));
    } catch (err) {
      live.error = controller.signal.aborted ? (live.stopReason ?? 'Stopped') : err instanceof Error ? err.message : String(err);
    } finally {
      live.done = true;
      announce.flush();
      const finished = [...streams.values()].filter((s) => s.workspaceId === workspaceId && s.done);
      for (const old of finished.slice(0, Math.max(0, finished.length - KEPT_STREAMS))) streams.delete(old.id);
    }
  })();
  return live.id;
}

function liveStream(ctx: CommandContext, streamId: string): LiveStream {
  const live = streams.get(streamId);
  if (!live || live.workspaceId !== ws(ctx).id) throw new QuiverError('NOT_FOUND', `Stream ${streamId} not found; finished streams are kept only for a while`);
  return live;
}

const streamRead = defineCommand({
  id: 'api.request.stream.read',
  title: 'Read a streamed response',
  description:
    'The items of a streamed response (an event stream, or a send with `stream`) after `since` (the `next` of the previous read, 0 for the start): events with their name, id and data, or lines. Also whether the stream ended (`done`, with `error` when it did not end by the server closing it: a line or event over 1 MB, or more than 20 streams open at once, close it) and how many items fell out of its buffer (5000 items or 16 MB) before they were read. Stop streams you are done with (api.request.stream.stop).',
  scope: 'workspace',
  input: z.object({ streamId: z.string(), since: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(STREAM_BUFFER).optional() }),
  handler: async ({ streamId, since, limit }, ctx): Promise<StreamRead> => {
    const live = liveStream(ctx, streamId);
    const from = since ?? 0;
    const firstSeq = live.items[0]?.seq ?? live.nextSeq;
    const items = live.items.filter((item) => item.seq >= from).slice(0, limit ?? STREAM_BUFFER);
    return {
      items,
      next: items.length ? items[items.length - 1].seq + 1 : Math.max(from, firstSeq),
      done: live.done && (items.length === 0 || items[items.length - 1].seq === live.nextSeq - 1),
      dropped: Math.max(0, firstSeq - from),
      error: live.error,
      bytes: live.bytes,
    };
  },
});

const streamStop = defineCommand({
  id: 'api.request.stream.stop',
  title: 'Stop a streamed response',
  description: 'Closes the connection of a streamed response. What arrived stays readable. Returns whether it was still open.',
  scope: 'workspace',
  input: z.object({ streamId: z.string() }),
  handler: async ({ streamId }, ctx) => {
    const live = liveStream(ctx, streamId);
    const open = !live.done;
    if (open) live.controller.abort();
    return { stopped: open };
  },
});

// ---------- collection runs ----------

const RUNS_LOG = 'runs';
/** Finished runs kept in memory per workspace, for api.run.get right after a run; older ones are read from the log. */
const KEPT_RUNS = 10;

interface LiveRun {
  run: ApiRun;
  workspaceId: string;
  controller: AbortController;
}

const runs = new Map<string, LiveRun>();

function announceRun(ctx: CommandContext, live: LiveRun): void {
  ctx.host.emit('api.changed', { workspaceId: live.workspaceId, reason: 'run', runId: live.run.id });
}

/** A copy that later changes to the live run do not reach. */
function snapshot(run: ApiRun): ApiRun {
  return { ...run, items: run.items.map((item) => ({ ...item })) };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

/** Send the run's requests one after another, each seeing what the captures before it wrote. */
async function executeRun(ctx: CommandContext, live: LiveRun, options: { environmentId?: string | null; stopOnFail: boolean; delayMs: number }): Promise<void> {
  const { run, controller } = live;
  const w = ws(ctx);
  for (let i = 0; i < run.items.length; i++) {
    const item = run.items[i];
    if (controller.signal.aborted) break;
    item.status = 'running';
    announceRun(ctx, live);
    let entry: HistoryEntry | undefined;
    let secretValues: string[] = [];
    try {
      const response = await sendRequest(ctx, { requestId: item.requestId, environmentId: options.environmentId }, controller.signal, (e, values) => ((entry = e), (secretValues = values)), false);
      item.httpStatus = response.status;
      item.durationMs = Math.round(response.timings.total);
      // What a check read can be a secret (a token's JSON path); the run is a plain file and agents read it.
      if (response.checks) item.checks = scrubCheckResults(response.checks, secretValues);
      const captured = response.captured?.filter((c) => c.ok).map((c) => c.variable);
      if (captured?.length) item.captured = captured;
      item.status = response.checks?.some((c) => !c.ok) ? 'failed' : 'passed';
    } catch (err) {
      const cancelled = controller.signal.aborted;
      item.status = cancelled ? 'cancelled' : 'error';
      item.error = entry?.error ?? (err instanceof Error ? err.message : String(err));
    }
    item.url = entry?.url ?? null;
    if (item.status === 'passed') run.passed++;
    else if (item.status === 'failed' || item.status === 'error') run.failed++;
    announceRun(ctx, live);
    if (options.stopOnFail && (item.status === 'failed' || item.status === 'error')) {
      for (const rest of run.items.slice(i + 1)) rest.status = 'skipped';
      break;
    }
    if (options.delayMs && i < run.items.length - 1) await wait(options.delayMs, controller.signal);
  }
  if (controller.signal.aborted) for (const item of run.items) if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled';
  run.status = controller.signal.aborted ? 'cancelled' : run.failed ? 'failed' : 'passed';
  run.finishedAt = nowIso();
  // Item URLs and errors are already masked like history entries; the log is a plain file.
  await w.store.appendLog(RUNS_LOG, run);
  ctx.host.emit('store.changed', { workspaceId: w.id, collection: RUNS_LOG });
  announceRun(ctx, live);
  const finished = [...runs.values()].filter((r) => r.workspaceId === live.workspaceId && r.run.finishedAt);
  for (const old of finished.slice(0, Math.max(0, finished.length - KEPT_RUNS))) runs.delete(old.run.id);
}

const collectionRun = defineCommand({
  id: 'api.collection.run',
  title: 'Run API collection',
  description:
    'Sends the requests of a collection one after another, in their order (then its sub-collections\', by name, unless recursive is false), applying each request\'s captures before the next one is sent and running its checks. Returns { runId } at once; follow it with api.run.get, stop it with api.run.cancel. An item passes when a response came back and every check passed, fails when a check failed, and is an error when no response came back. With stopOnFail the run stops at the first failure or error. Every send is recorded in the history; the finished run is kept in api.run.list.',
  scope: 'workspace',
  input: z.object({
    collectionId: z.string(),
    environmentId: z.string().nullable().optional().describe('The environment to resolve variables from and write captures to; the active one when left out.'),
    recursive: z.boolean().optional().describe('Include sub-collections (the default).'),
    stopOnFail: z.boolean().optional(),
    delayMs: z.number().int().min(0).max(60_000).optional().describe('A pause between requests.'),
  }),
  handler: async (input, ctx) => {
    const w = ws(ctx);
    const collections = await listCollections(w);
    const collection = collections.find((c) => c.id === input.collectionId);
    if (!collection) throw new QuiverError('NOT_FOUND', `Collection ${input.collectionId} not found`);
    const requests = runOrder(collections, await w.store.list<ApiRequest>(COLLECTIONS.requests), collection.id, input.recursive ?? true);
    if (!requests.length) throw new QuiverError('INVALID_INPUT', `${collection.name} has no requests to run`);
    const run: ApiRun = {
      id: newId(),
      collectionId: collection.id,
      collectionName: collection.name,
      environmentId: input.environmentId === undefined ? await getActiveEnvironmentId(w) : input.environmentId,
      startedAt: nowIso(),
      finishedAt: null,
      status: 'running',
      stopOnFail: input.stopOnFail ?? false,
      items: requests.map((r) => ({ requestId: r.id, name: r.name, method: r.method, url: null, status: 'pending', httpStatus: null, durationMs: null })),
      passed: 0,
      failed: 0,
    };
    const live: LiveRun = { run, workspaceId: w.id, controller: new AbortController() };
    runs.set(run.id, live);
    announceRun(ctx, live);
    void executeRun(ctx, live, { environmentId: run.environmentId, stopOnFail: run.stopOnFail, delayMs: input.delayMs ?? 0 }).catch((err) => {
      console.warn(`[quiver] collection run ${run.id} failed: ${(err as Error).message}`);
      run.status = 'failed';
      run.finishedAt ??= nowIso();
      announceRun(ctx, live);
    });
    return { runId: run.id, requests: requests.length };
  },
});

const runGet = defineCommand({
  id: 'api.run.get',
  title: 'Get a collection run',
  description: 'A collection run, running or finished: each request with its status (pending, running, passed, failed, error, skipped, cancelled), HTTP status, time, checks and error, and the passed and failed counts.',
  scope: 'workspace',
  input: z.object({ runId: z.string() }),
  handler: async ({ runId }, ctx) => {
    const w = ws(ctx);
    const live = runs.get(runId);
    if (live && live.workspaceId === w.id) return snapshot(live.run);
    const logged = (await w.store.readLog<ApiRun>(RUNS_LOG, 500)).find((r) => r.id === runId);
    if (!logged) throw new QuiverError('NOT_FOUND', `Run ${runId} not found`);
    return logged;
  },
});

const runCancel = defineCommand({
  id: 'api.run.cancel',
  title: 'Stop a collection run',
  description: 'Stops a running collection run: the request in flight is cancelled and the rest are not sent. Returns whether a running run was found.',
  scope: 'workspace',
  input: z.object({ runId: z.string() }),
  handler: async ({ runId }, ctx) => {
    const live = runs.get(runId);
    const running = Boolean(live && live.workspaceId === ws(ctx).id && !live.run.finishedAt);
    if (running) live!.controller.abort();
    return { cancelled: running };
  },
});

const runList = defineCommand({
  id: 'api.run.list',
  title: 'List collection runs',
  description: 'Collection runs, newest first: the running ones, then the finished ones from the log, optionally of one collection.',
  scope: 'workspace',
  input: z.object({ collectionId: z.string().optional(), limit: z.number().int().min(1).max(200).default(20) }),
  handler: async ({ collectionId, limit }, ctx) => {
    const w = ws(ctx);
    const running = [...runs.values()].filter((r) => r.workspaceId === w.id && !r.run.finishedAt).map((r) => snapshot(r.run));
    const finished = await w.store.readLog<ApiRun>(RUNS_LOG, collectionId ? 500 : limit);
    return [...running.reverse(), ...finished].filter((r) => !collectionId || r.collectionId === collectionId).slice(0, limit);
  },
});

const collectionReorder = defineCommand({
  id: 'api.collection.reorder',
  title: 'Reorder requests in a collection',
  description: 'Sets the order of requests in a collection (null for the top level), which the tree and collection runs follow. Every id must be a request in that collection; requests not listed keep no order and follow, by name.',
  scope: 'workspace',
  input: z.object({ collectionId: z.string().nullable(), requestIds: z.array(z.string()).min(1) }),
  handler: async ({ collectionId, requestIds }, ctx) => {
    const w = ws(ctx);
    const all = await w.store.list<ApiRequest>(COLLECTIONS.requests);
    const inCollection = all.filter((r) => (r.collectionId ?? null) === collectionId);
    for (const id of requestIds) if (!inCollection.some((r) => r.id === id)) throw new QuiverError('INVALID_INPUT', `Request ${id} is not in that collection`);
    for (const r of inCollection) {
      const at = requestIds.indexOf(r.id);
      const order = at >= 0 ? at : undefined;
      if (r.order === order) continue;
      const { order: _old, ...rest } = r;
      await w.store.put(COLLECTIONS.requests, order === undefined ? rest : { ...rest, order });
    }
    return { ordered: requestIds.length };
  },
});

// ---------- network: proxy and client certificates ----------

/** The proxy settings without the encrypted password, which no caller needs back. */
function proxyView(config: NetworkConfig) {
  const { passwordCipher, ...rest } = config;
  return { ...rest, hasPassword: Boolean(passwordCipher) };
}

const networkGet = defineCommand({
  id: 'api.network.get',
  title: 'Network settings',
  description: 'How the API client, realtime connections and GraphQL introspection reach the network: no proxy, the system proxy (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) or a manual one, with the hosts that bypass it. The proxy password is never returned.',
  scope: 'global',
  input: z.object({}),
  handler: async (_i, ctx) => proxyView(networkConfig(ctx.host)),
});

const networkSave = defineCommand({
  id: 'api.network.save',
  title: 'Save network settings',
  description: 'Sets the proxy for this machine: none, system or manual (url, username, and a password kept encrypted; omit password to keep it, an empty one clears it), and the hosts that bypass it.',
  scope: 'global',
  mutating: true,
  input: z.object({
    proxy: z.enum(['none', 'system', 'manual']),
    url: z.string().default(''),
    noProxy: z.array(z.string()).default([]),
    username: z.string().default(''),
    password: z.string().optional(),
  }),
  handler: async ({ proxy, url, noProxy, username, password }, ctx) => {
    if (proxy === 'manual') {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url.trim());
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new QuiverError('INVALID_INPUT', 'A manual proxy needs a URL like http://proxy.example.com:3128');
    }
    const current = networkConfig(ctx.host);
    const passwordCipher = password === undefined ? current.passwordCipher : password ? ctx.host.secrets.encrypt(password) : '';
    const next: NetworkConfig = { proxy, url: url.trim(), noProxy: noProxy.map((h) => h.trim()).filter(Boolean), username: username.trim(), passwordCipher };
    await ctx.host.config.update({ network: next });
    return proxyView(next);
  },
});

/** A certificate as callers see it: no passphrase; for agents, file names without the folders they sit in. */
function certificateView(c: ClientCertificate, agent: boolean) {
  const { passphraseCipher, ...rest } = c;
  const shown = (p: string) => (agent && p ? path.basename(p) : p);
  return { ...rest, certPath: shown(c.certPath), keyPath: shown(c.keyPath), pfxPath: shown(c.pfxPath), caPath: shown(c.caPath), hasPassphrase: Boolean(passphraseCipher) };
}

const certificateList = defineCommand({
  id: 'api.certificate.list',
  title: 'List client certificates',
  description: 'Client certificates of this workspace on this machine, by host pattern: the files (PEM certificate and key, or a PKCS#12 file, and an optional CA). Passphrases are never returned; agents get file names only.',
  scope: 'workspace',
  input: z.object({}),
  handler: async (_i, ctx) => (await readCertificates(ws(ctx))).map((c) => certificateView(c, ctx.caller === 'mcp')),
});

const certificateSave = defineCommand({
  id: 'api.certificate.save',
  title: 'Save a client certificate',
  description: 'Adds or replaces a client certificate for the hosts matching hostPattern (api.example.com, *.example.com, optionally :port). Give certPath and keyPath (PEM) or pfxPath (PKCS#12); paths relative to the project folder resolve against it. Omit passphrase to keep the stored one; an empty one clears it.',
  scope: 'workspace',
  mutating: true,
  input: z.object({
    certificate: z.object({
      id: z.string().optional(),
      hostPattern: z.string().min(1),
      certPath: z.string().default(''),
      keyPath: z.string().default(''),
      pfxPath: z.string().default(''),
      caPath: z.string().default(''),
      passphrase: z.string().optional(),
    }),
  }),
  handler: async ({ certificate }, ctx) => {
    const w = ws(ctx);
    if (!certificate.pfxPath.trim() && !(certificate.certPath.trim() && certificate.keyPath.trim())) {
      throw new QuiverError('INVALID_INPUT', 'Give a certificate and its key (PEM), or a PKCS#12 file');
    }
    const all = await readCertificates(w);
    const existing = certificate.id ? all.find((c) => c.id === certificate.id) : undefined;
    const { passphrase, ...fields } = certificate;
    const saved: ClientCertificate = {
      ...fields,
      id: existing?.id ?? newId(),
      hostPattern: fields.hostPattern.trim(),
      passphraseCipher: passphrase === undefined ? (existing?.passphraseCipher ?? '') : passphrase ? ctx.host.secrets.encrypt(passphrase) : '',
    };
    await w.store.writeLocal(CERTIFICATES_DOC, existing ? all.map((c) => (c.id === saved.id ? saved : c)) : [...all, saved]);
    ctx.host.emit('store.changed', { workspaceId: w.id, collection: CERTIFICATES_DOC });
    return certificateView(saved, ctx.caller === 'mcp');
  },
});

const certificateDelete = defineCommand({
  id: 'api.certificate.delete',
  title: 'Delete a client certificate',
  description: 'Removes a client certificate from this workspace (the files stay where they are).',
  scope: 'workspace',
  mutating: true,
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => {
    const w = ws(ctx);
    const all = await readCertificates(w);
    const left = all.filter((c) => c.id !== id);
    await w.store.writeLocal(CERTIFICATES_DOC, left);
    ctx.host.emit('store.changed', { workspaceId: w.id, collection: CERTIFICATES_DOC });
    return { deleted: left.length !== all.length };
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

/** Files larger than this are refused before they are read: an API description or a recording is far smaller. */
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

const ImportSource = z
  .union([z.object({ text: z.string().min(1) }), z.object({ path: z.string().min(1).describe('A file to read; relative paths are relative to the project folder, and agents may only read inside it.') })])
  .describe('The file contents as `text`, or a `path` to read them from.');

const ImportInput = z.object({
  source: ImportSource,
  collectionId: z.string().nullable().optional().describe('The collection to import under; the root of the tree when left out.'),
  name: z.string().optional().describe('A name for the imported collection instead of the one in the file.'),
});

async function importText(ctx: CommandContext, source: z.infer<typeof ImportSource>): Promise<string> {
  if ('text' in source) return source.text;
  const w = ws(ctx);
  const given = source.path.trim();
  const abs = path.isAbsolute(given) ? path.normalize(given) : path.resolve(w.path, given);
  if (ctx.caller === 'mcp') {
    const placed = await agentPath(w.path, given);
    if (placed.refused) throw new QuiverError('INVALID_INPUT', `Agents may only import files inside the project folder; ${placed.refused}`);
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile()) throw new QuiverError('INVALID_INPUT', `The file ${given} does not exist`);
  if (stat.size > MAX_IMPORT_BYTES) throw new QuiverError('INVALID_INPUT', `${given} is ${Math.round(stat.size / 1024 / 1024)} MB; files over ${MAX_IMPORT_BYTES / 1024 / 1024} MB are not imported`);
  return (await fs.readFile(abs, 'utf8')).replace(/^﻿/, '');
}

/**
 * Reads and converts the whole file before anything is saved, so a broken file leaves the
 * workspace as it was. Imports only add: collections, requests and environments are new.
 */
async function runImport(ctx: CommandContext, input: z.infer<typeof ImportInput>, convert: (text: string) => ImportResult) {
  const w = ws(ctx);
  const text = await importText(ctx, input.source);
  let result: ImportResult;
  try {
    result = convert(text);
  } catch (err) {
    if (err instanceof ImportError) throw new QuiverError('INVALID_INPUT', err.message);
    throw err;
  }
  const parentId = input.collectionId ?? null;
  if (parentId && !(await w.store.get<ApiCollection>(COLLECTIONS.collections, parentId))) throw new QuiverError('NOT_FOUND', `Collection ${parentId} not found`);
  const [root] = result.collections;
  if (root) {
    root.parentId = parentId;
    if (input.name?.trim()) root.name = input.name.trim();
  }
  const collections = result.collections.map((c) => ApiCollectionSchema.parse(c));
  const requests = result.requests.map((r) => ApiRequestSchema.parse(r));
  const environments = result.environments.map((e) => EnvironmentSchema.parse(e));
  // Parents before children, so the tree never shows a request without its collection.
  for (const c of collections) await w.store.put(COLLECTIONS.collections, c);
  for (const r of requests) await w.store.put(COLLECTIONS.requests, r);
  const savedEnvironments = [];
  for (const e of environments) savedEnvironments.push(await saveEnvironment(w, ctx.host, e));
  return {
    collectionId: root?.id ?? null,
    name: root?.name ?? null,
    requests: requests.length,
    collections: collections.length,
    environments: savedEnvironments.length,
    environmentIds: savedEnvironments.map((e) => e.id),
    skipped: result.skipped,
  };
}

const IMPORT_RESULT = 'Returns the new collection id, how many requests and environments were created, and what was found but not imported (`skipped`). A file that cannot be read is refused and nothing is saved; nothing that exists is changed.';

const importOpenApiCommand = defineCommand({
  id: 'api.import.openapi',
  title: 'Import from OpenAPI',
  description: `Imports an OpenAPI 3.0/3.1 or Swagger 2.0 document (JSON or YAML) as a collection: one collection per tag, one request per operation, the first server as the base URL, path parameters as {{variables}}, bodies from examples or the schema, security schemes as collection auth with credentials as {{variables}}. ${IMPORT_RESULT}`,
  scope: 'workspace',
  input: ImportInput,
  handler: (input, ctx) => runImport(ctx, input, importOpenApi),
});

const importPostmanCommand = defineCommand({
  id: 'api.import.postman',
  title: 'Import from Postman',
  description: `Imports a Postman Collection v2.1 (or v2.0) with its folders, requests, bodies and auth, its variables as an environment; or a Postman environment file. Pre-request and test scripts are listed in skipped, not imported. ${IMPORT_RESULT}`,
  scope: 'workspace',
  input: ImportInput,
  handler: (input, ctx) => runImport(ctx, input, importPostman),
});

const importInsomniaCommand = defineCommand({
  id: 'api.import.insomnia',
  title: 'Import from Insomnia',
  description: `Imports an Insomnia export, v4 (JSON) or v5 (YAML): the workspace's folders and requests, and its environments (each sub-environment with the base merged in). Templates like {{ _.host }} become {{host}}. ${IMPORT_RESULT}`,
  scope: 'workspace',
  input: ImportInput,
  handler: (input, ctx) => runImport(ctx, input, importInsomnia),
});

const importHarCommand = defineCommand({
  id: 'api.import.har',
  title: 'Import from HAR',
  description: `Imports the API calls of a HAR 1.2 recording (a browser's "Save all as HAR"), a collection per host. Page loads and repeated requests are left out, cookies are dropped, and credentials (Authorization, API key headers, token parameters, password fields) are replaced with {{variables}}. ${IMPORT_RESULT}`,
  scope: 'workspace',
  input: ImportInput.extend({ host: z.string().optional().describe('Only requests to this host; a leading dot (.example.com) includes its subdomains.') }),
  handler: (input, ctx) => runImport(ctx, input, (text) => importHar(text, { host: input.host })),
});

const ExportInput = z.object({ requestId: z.string().optional(), request: ApiRequestSchema.optional(), environmentId: z.string().nullable().optional() });

/**
 * What a request sends, ready for code: variables resolved, inheritance and a cached OAuth token
 * applied (never a sign-in for a copy), files as references. For agents, credentials and secret
 * variables are masked, as in `sent`: a command an agent asks for is one it reads, not one pasted.
 */
async function exportInput(ctx: CommandContext, input: z.infer<typeof ExportInput>): Promise<CodeInput> {
  const request = input.request ?? (input.requestId ? await requireRequest(ws(ctx), input.requestId) : null);
  if (!request) throw new QuiverError('INVALID_INPUT', 'Provide requestId or request');
  const vars = await resolveVariableMap(ws(ctx), ctx.host, input.environmentId);
  const written = resolveDeep(await withInheritance(ws(ctx), request), vars);
  const resolved = await applyOAuth(ctx, written, 'optional', await resolveNetwork(ctx.host, ws(ctx)));
  const prepared = await prepareRequest(resolved);
  const wire = { method: prepared.method, url: prepared.url, headers: prepared.headers, bodyPreview: typeof prepared.body === 'string' ? prepared.body : null };
  const known = ctx.caller === 'mcp' ? await knownSecrets(ctx, resolved, input.environmentId) : null;
  const shown = known ? redactSent(wire, known) : wire;
  // A multipart text field is masked like a header: by its name, and wherever a secret the request resolved to appears.
  const fieldValue = (name: string, value: string) => (!known ? value : isSecretName(name) ? redactLiteral(value) : scrubSecrets(value, known.values));
  const b = resolved.body;
  const body: CodeBody =
    b.type === 'form'
      ? {
          kind: 'form',
          fields: b.fields
            .filter((f) => f.enabled && f.key.trim())
            .map((f) => (f.kind === 'file' ? { name: f.key.trim(), file: f.value.trim(), type: f.contentType?.trim() || undefined, fileName: f.fileName?.trim() || undefined } : ([f.key, fieldValue(f.key, f.value)] as [string, string]))),
        }
      : b.type === 'binary'
        ? { kind: 'file', path: b.path.trim() }
        : shown.bodyPreview !== null && shown.bodyPreview !== ''
          ? { kind: 'text', text: shown.bodyPreview }
          : { kind: 'none' };
  return {
    method: shown.method,
    url: shown.url,
    headers: shown.headers,
    body,
    // Tools' own defaults differ from Quiver's (curl follows no redirects and has no time limit), so say what this request does.
    options: { ...effectiveSendOptions(request.options), timeoutMs: request.options?.timeoutMs },
  };
}

const exportCurl = defineCommand({
  id: 'api.export.curl',
  title: 'Copy as curl',
  description: 'Renders a request as a curl command with variables resolved. For agents, credentials and secret variables are masked in it.',
  scope: 'workspace',
  input: ExportInput,
  handler: async (input, ctx) => ({ command: toCode('curl', await exportInput(ctx, input)) }),
});

const exportCode = defineCommand({
  id: 'api.export.code',
  title: 'Copy as code',
  description: `Renders a request as code that sends it: ${CODE_TARGETS.map((t) => `${t.value} (${t.label})`).join(', ')}. Variables are resolved and files are referenced by path; for agents, credentials and secret variables are masked, as in api.export.curl.`,
  scope: 'workspace',
  input: ExportInput.extend({ target: z.enum(CODE_TARGETS.map((t) => t.value) as [CodeTarget, ...CodeTarget[]]) }),
  handler: async (input, ctx) => ({ target: input.target, code: toCode(input.target, await exportInput(ctx, input)) }),
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
      withHistory(w, () => tidyHistory(w)).catch((err) => console.warn(`[quiver] could not tidy the request history of ${w.path}: ${(err as Error).message}`)),
    );
  },
  onWorkspaceClose: (w) => {
    historyReady.delete(w.id);
    for (const live of runs.values()) if (live.workspaceId === w.id) live.controller.abort();
    for (const live of streams.values()) if (live.workspaceId === w.id) live.controller.abort();
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
    historyGet,
    historyClear,
    collectionRun,
    collectionReorder,
    runGet,
    runCancel,
    streamRead,
    streamStop,
    runList,
    networkGet,
    networkSave,
    certificateList,
    certificateSave,
    certificateDelete,
    importCurl,
    importOpenApiCommand,
    importPostmanCommand,
    importInsomniaCommand,
    importHarCommand,
    exportCurl,
    exportCode,
    fileStat,
    suggestName,
  ],
});
