import { createHash } from 'node:crypto';
import { QuiverError, SendOptionsSchema, type ApiRequest, type GraphqlSchemaDoc, type WorkspaceApi } from '@quiver/core';
import { buildClientSchema, getIntrospectionQuery, printSchema, type IntrospectionQuery } from 'graphql';
import { prepareRequest, sendPrepared } from './http';

/** Schemas are cached per endpoint; the query string (which may carry an API key) is not part of the key. */
export function graphqlEndpoint(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function schemaDocName(endpoint: string): string {
  return `graphql-schema-${createHash('sha1').update(endpoint).digest('hex').slice(0, 16)}`;
}

export async function readSchema(ws: WorkspaceApi, endpoint: string): Promise<GraphqlSchemaDoc | null> {
  const doc = await ws.store.readLocal<GraphqlSchemaDoc | null>(schemaDocName(endpoint), null);
  return doc && typeof doc === 'object' && typeof doc.sdl === 'string' ? doc : null;
}

/**
 * POST the standard introspection query with the request's URL, headers and auth (its own body is
 * ignored), then cache the schema as SDL under `.quiver/local` for editors, the explorer and agents.
 */
export async function introspect(ws: WorkspaceApi, resolved: ApiRequest): Promise<GraphqlSchemaDoc> {
  const probe: ApiRequest = {
    ...resolved,
    method: 'POST',
    body: { type: 'json', content: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true }) }) },
  };
  const prepared = prepareRequest(probe);
  const endpoint = graphqlEndpoint(prepared.url);
  const response = await sendPrepared(prepared, SendOptionsSchema.parse({ maxBodyBytes: 64 * 1024 * 1024 }));
  if (response.bodyEncoding !== 'utf8') {
    throw new QuiverError('REQUEST_FAILED', `Introspection returned a binary body (${response.contentType ?? 'unknown content type'})`, { status: response.status });
  }
  let parsed: { data?: IntrospectionQuery | null; errors?: { message: string }[] };
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    throw new QuiverError('REQUEST_FAILED', `Introspection returned ${response.status} with a non-JSON body`, { status: response.status, body: response.body.slice(0, 500) });
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.data) {
    const reason = parsed?.errors?.map((e) => e.message).join('; ');
    throw new QuiverError('REQUEST_FAILED', reason || `Introspection returned ${response.status} without data`, { status: response.status });
  }
  let sdl: string;
  let typeCount: number;
  try {
    const schema = buildClientSchema(parsed.data);
    sdl = printSchema(schema);
    typeCount = Object.keys(schema.getTypeMap()).filter((name) => !name.startsWith('__')).length;
  } catch (err) {
    throw new QuiverError('REQUEST_FAILED', `Introspection result is not a valid schema: ${(err as Error).message}`);
  }
  const doc: GraphqlSchemaDoc = { url: endpoint, fetchedAt: new Date().toISOString(), sdl, typeCount };
  await ws.store.writeLocal(schemaDocName(endpoint), doc);
  return doc;
}
