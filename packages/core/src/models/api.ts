import { z } from 'zod';
import { newId, nowIso } from '../ids';

export const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const KeyValueSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
});
export type KeyValue = z.infer<typeof KeyValueSchema>;

export const VariableSchema = KeyValueSchema.extend({
  secret: z.boolean().optional(),
});

export const RequestBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('json'), content: z.string() }),
  z.object({ type: z.literal('text'), content: z.string() }),
  z.object({ type: z.literal('xml'), content: z.string() }),
  z.object({ type: z.literal('urlencoded'), fields: z.array(KeyValueSchema) }),
  z.object({ type: z.literal('form'), fields: z.array(KeyValueSchema) }),
  /** Sent as `{"query","variables","operationName"}` JSON (or query parameters for GET). `variables` is JSON text. */
  z.object({ type: z.literal('graphql'), query: z.string(), variables: z.string(), operationName: z.string().optional() }),
]);
export type RequestBody = z.infer<typeof RequestBodySchema>;

/** An introspected GraphQL schema, cached per endpoint under `.quiver/local`. */
export interface GraphqlSchemaDoc {
  /** Endpoint the schema was fetched from, after variable resolution. */
  url: string;
  fetchedAt: string;
  /** The schema as SDL, which is what editors, the explorer and agents read. */
  sdl: string;
  typeCount: number;
}

export const RequestAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({
    type: z.literal('apikey'),
    key: z.string(),
    value: z.string(),
    in: z.enum(['header', 'query']),
  }),
]);
export type RequestAuth = z.infer<typeof RequestAuthSchema>;

export const SendOptionsSchema = z.object({
  followRedirects: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  /** Accept self-signed or otherwise invalid TLS certificates. */
  insecure: z.boolean().default(false),
  /** Cap on the body kept in memory and returned to the UI. */
  maxBodyBytes: z.number().int().positive().default(10 * 1024 * 1024),
});
export type SendOptions = z.infer<typeof SendOptionsSchema>;

/**
 * What a request sets for itself: only the options that differ from the defaults, so a committed
 * request says "this endpoint needs 120 s" and nothing else.
 */
export const RequestOptionsSchema = z.object({
  followRedirects: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  insecure: z.boolean().optional(),
  maxBodyBytes: z.number().int().positive().optional(),
});
export type RequestOptions = z.infer<typeof RequestOptionsSchema>;

/** The options a send uses: the defaults, then the request's own, then the caller's. */
export function effectiveSendOptions(request?: RequestOptions, call?: RequestOptions): SendOptions {
  const defined = (o?: RequestOptions) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
  return SendOptionsSchema.parse({ ...defined(request), ...defined(call) });
}

/** Keep only the options that differ from the defaults; undefined when none does. */
export function requestOptionOverrides(options?: RequestOptions): RequestOptions | undefined {
  if (!options) return undefined;
  const defaults = SendOptionsSchema.parse({});
  const kept = Object.fromEntries(Object.entries(options).filter(([k, v]) => v !== undefined && v !== defaults[k as keyof SendOptions])) as RequestOptions;
  return Object.keys(kept).length ? kept : undefined;
}

export const ApiRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  collectionId: z.string().nullable().default(null),
  method: HttpMethodSchema,
  url: z.string(),
  params: z.array(KeyValueSchema).default([]),
  headers: z.array(KeyValueSchema).default([]),
  body: RequestBodySchema.default({ type: 'none' }),
  auth: RequestAuthSchema.default({ type: 'none' }),
  description: z.string().optional(),
  /** Send options this request overrides (timeout, redirects, TLS, body cap). */
  options: RequestOptionsSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApiRequest = z.infer<typeof ApiRequestSchema>;

export const ApiCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type ApiCollection = z.infer<typeof ApiCollectionSchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  variables: z.array(VariableSchema).default([]),
});
export type Environment = z.infer<typeof EnvironmentSchema>;



/** One redirect followed while sending: the request that got it and where it pointed. */
export interface RedirectHop {
  method: HttpMethod;
  url: string;
  status: number;
  statusText: string;
  /** The absolute URL the next request went to. */
  location: string;
  headers: [string, string][];
  durationMs: number;
}

export interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  contentType: string | null;
  size: number;
  truncated: boolean;
  /** Milliseconds: the whole send, until the final response's headers, and reading its body. */
  timings: { total: number; ttfb: number; download: number };
  /** The redirects followed on the way, in order; empty when there were none or they were not followed. */
  redirects: RedirectHop[];
  /** The final response's Set-Cookie headers, one per cookie (the joined `set-cookie` header cannot be split safely). */
  setCookies: string[];
  /** The request after variable resolution and auth application. */
  sent: { method: HttpMethod; url: string; headers: [string, string][]; bodyPreview: string | null };
}

export interface HistoryEntry {
  id: string;
  at: string;
  requestId: string | null;
  method: HttpMethod;
  url: string;
  status: number | null;
  durationMs: number | null;
  error: string | null;
  request: ApiRequest;
}

export function keyValue(key = '', value = '', enabled = true): KeyValue {
  return { id: newId(), key, value, enabled };
}

export function newApiRequest(partial: Partial<ApiRequest> = {}): ApiRequest {
  const ts = nowIso();
  return {
    id: newId(),
    name: 'New request',
    collectionId: null,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  };
}

export function newCollection(name: string, parentId: string | null = null): ApiCollection {
  return { id: newId(), name, parentId, createdAt: nowIso() };
}

export function newEnvironment(name: string): Environment {
  return { id: newId(), name, variables: [] };
}
