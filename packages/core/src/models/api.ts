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

/**
 * A multipart field: text, or (`kind: 'file'`) a file whose path is `value`, relative to the project
 * folder when the file is inside it so the committed request works for everyone. Fields saved before
 * files existed have no `kind` and are text.
 */
export const FormFieldSchema = KeyValueSchema.extend({
  kind: z.enum(['text', 'file']).optional(),
  /** The file name sent for a file field; the file's own name when absent. */
  fileName: z.string().optional(),
  /** The part's content type; guessed from the file name when absent. */
  contentType: z.string().optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const RequestBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('json'), content: z.string() }),
  z.object({ type: z.literal('text'), content: z.string() }),
  z.object({ type: z.literal('xml'), content: z.string() }),
  z.object({ type: z.literal('urlencoded'), fields: z.array(KeyValueSchema) }),
  z.object({ type: z.literal('form'), fields: z.array(FormFieldSchema) }),
  /** A file sent as the body as it is; `path` is relative to the project folder when the file is inside it. */
  z.object({ type: z.literal('binary'), path: z.string(), contentType: z.string().optional() }),
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

/**
 * The auth of an API request or collection: one of the shared kinds, or `inherit`, which takes the
 * auth of the nearest collection above that sets one (none at the top level). Realtime connections
 * and MCP servers keep `RequestAuthSchema`, since they sit in no collection.
 */
/**
 * OAuth 2.0: the request carries a token got from \`tokenUrl\`, by client credentials or by a sign-in
 * in a Quiver window (authorization code, PKCE by default). Tokens are cached per machine, encrypted.
 */
export const OAuth2AuthSchema = z.object({
  type: z.literal('oauth2'),
  grant: z.enum(['client_credentials', 'authorization_code']),
  tokenUrl: z.string(),
  /** The authorize page, for the authorization code grant. */
  authUrl: z.string().optional(),
  clientId: z.string(),
  /** Empty for a public client; reference a secret variable rather than typing it. */
  clientSecret: z.string(),
  /** Space-separated. */
  scopes: z.string(),
  audience: z.string().optional(),
  /** How the client authenticates at the token URL: an HTTP Basic header, or client_id and client_secret in the body. */
  clientAuth: z.enum(['basic', 'body']),
  pkce: z.boolean(),
  /** The callback listens on http://127.0.0.1:<port>/callback; a free port when absent. Set one to register a fixed redirect URI. */
  callbackPort: z.number().int().min(1).max(65535).optional(),
  /** Put before the token in the Authorization header; Bearer when absent. */
  headerPrefix: z.string().optional(),
});
export type OAuth2Auth = z.infer<typeof OAuth2AuthSchema>;

export const ApiAuthSchema = z.discriminatedUnion('type', [...RequestAuthSchema.options, OAuth2AuthSchema, z.object({ type: z.literal('inherit') })]);
export type ApiAuth = z.infer<typeof ApiAuthSchema>;
/** Auth that says how to authenticate itself: anything but \`inherit\`. */
export type ConcreteAuth = Exclude<ApiAuth, { type: 'inherit' }>;

export const SendOptionsSchema = z.object({
  followRedirects: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  /** Accept self-signed or otherwise invalid TLS certificates. */
  insecure: z.boolean().default(false),
  /** Cap on the body kept in memory and returned to the UI. */
  maxBodyBytes: z.number().int().positive().default(10 * 1024 * 1024),
  /** Send the workspace cookie jar's cookies and keep the ones responses set. */
  cookies: z.boolean().default(true),
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
  cookies: z.boolean().optional(),
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

export const CaptureSourceSchema = z.enum(['body', 'header', 'cookie', 'status']);
export type CaptureSource = z.infer<typeof CaptureSourceSchema>;

/**
 * One value a send takes from its response into a variable of the environment: from the body by a
 * JSON path (empty for the whole body), a header or a cookie by name, or the status code.
 */
export const CaptureSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  variable: z.string(),
  from: CaptureSourceSchema,
  path: z.string(),
  /** Stored encrypted on this machine like other secret variables, and masked for agents. */
  secret: z.boolean(),
});
export type Capture = z.infer<typeof CaptureSchema>;

/** What a capture did on a send. */
export interface CapturedValue {
  variable: string;
  /** The value written; masked for agents when the variable is secret. Null when nothing was written. */
  value: string | null;
  ok: boolean;
  error?: string;
  secret: boolean;
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
  auth: ApiAuthSchema.default({ type: 'none' }),
  description: z.string().optional(),
  /** Send options this request overrides (timeout, redirects, TLS, body cap). */
  options: RequestOptionsSchema.optional(),
  /** Values taken from the response into environment variables after each send; absent when there are none. */
  capture: z.array(CaptureSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApiRequest = z.infer<typeof ApiRequestSchema>;

export const ApiCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
  /** Prefixed to the URL of requests inside that start with `/`; the nearest non-empty one wins. */
  baseUrl: z.string().default(''),
  /** Sent with every request inside, below the collections above it; a request's own header of the same name wins. */
  headers: z.array(KeyValueSchema).default([]),
  /** Used by requests inside whose auth is `inherit`; `inherit` here passes on the parent's. */
  auth: ApiAuthSchema.default({ type: 'inherit' }),
  description: z.string().optional(),
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
  /** What the cookie jar did on this send, when it was used: the names sent, stored, deleted and rejected (with why). */
  cookieJar?: { sent: string[]; stored: string[]; deleted: string[]; rejected: { name: string; reason: string }[] };
  /** What the request's captures wrote into the environment, when it has any. */
  captured?: CapturedValue[];
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
  return { id: newId(), name, parentId, baseUrl: '', headers: [], auth: { type: 'inherit' }, createdAt: nowIso() };
}

export function newEnvironment(name: string): Environment {
  return { id: newId(), name, variables: [] };
}
