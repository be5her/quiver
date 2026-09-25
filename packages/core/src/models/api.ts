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

export const SendOptionsSchema = z.object({
  followRedirects: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(30_000),
  /** Accept self-signed or otherwise invalid TLS certificates. */
  insecure: z.boolean().default(false),
  /** Cap on the body kept in memory and returned to the UI. */
  maxBodyBytes: z.number().int().positive().default(10 * 1024 * 1024),
});
export type SendOptions = z.infer<typeof SendOptionsSchema>;

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
  timings: { total: number; ttfb: number };
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
