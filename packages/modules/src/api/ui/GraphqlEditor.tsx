import { toErrorPayload, type ApiRequest, type GraphqlSchemaDoc, type RequestBody } from '@quiver/core';
import { Button, CodeEditor, Label, Select, invoke, notify } from '@quiver/ui';
import { buildSchema, parse, print, type GraphQLSchema, type OperationDefinitionNode } from 'graphql';
import { BookOpen, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openSchemaTab } from './index';

export type GraphqlBody = Extract<RequestBody, { type: 'graphql' }>;

/** Built schemas keyed by SDL text, shared by every editor and explorer showing the same endpoint. */
const built = new Map<string, GraphQLSchema | null>();

export function schemaFromDoc(doc: GraphqlSchemaDoc | null): GraphQLSchema | null {
  if (!doc) return null;
  if (!built.has(doc.sdl)) {
    try {
      built.set(doc.sdl, buildSchema(doc.sdl, { assumeValidSDL: true }));
    } catch {
      built.set(doc.sdl, null);
    }
  }
  return built.get(doc.sdl) ?? null;
}

/** The cached schema of the request's endpoint, refreshed when the URL settles, plus a way to introspect. */
export function useGraphqlSchema(request: ApiRequest | null) {
  const [doc, setDoc] = useState<GraphqlSchemaDoc | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const url = request?.url ?? '';

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke<GraphqlSchemaDoc | null>('api.graphql.schema', { request: requestRef.current })
        .then((d) => !cancelled && setDoc(d))
        .catch(() => !cancelled && setDoc(null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Re-run when the endpoint changes; headers and auth only matter for fetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, request?.id]);

  const fetchSchema = useCallback(async () => {
    if (!requestRef.current) return null;
    setFetching(true);
    setError(null);
    try {
      const d = await invoke<GraphqlSchemaDoc>('api.graphql.introspect', { request: requestRef.current });
      setDoc(d);
      return d;
    } catch (err) {
      const message = toErrorPayload(err).message;
      setError(message);
      notify(message, 'error');
      return null;
    } finally {
      setFetching(false);
    }
  }, []);

  const schema = useMemo(() => schemaFromDoc(doc), [doc]);
  return { doc, schema, fetching, error, fetchSchema };
}

function operationsOf(query: string): OperationDefinitionNode[] {
  try {
    return parse(query).definitions.filter((d): d is OperationDefinitionNode => d.kind === 'OperationDefinition');
  } catch {
    return [];
  }
}

export function GraphqlEditor({ body, onChange, request }: { body: GraphqlBody; onChange(body: GraphqlBody): void; request: ApiRequest }) {
  const { doc, schema, fetching, fetchSchema } = useGraphqlSchema(request);
  const operations = useMemo(() => operationsOf(body.query), [body.query]);
  const named = operations.filter((op) => op.name?.value);

  const prettify = () => {
    try {
      onChange({ ...body, query: print(parse(body.query)) });
    } catch (err) {
      notify(`Cannot format: ${(err as Error).message}`, 'error');
    }
    if (body.variables.trim()) {
      try {
        onChange({ ...body, query: print(parse(body.query)), variables: JSON.stringify(JSON.parse(body.variables), null, 2) });
      } catch {
        // leave variables as typed
      }
    }
  };

  const status = doc ? `Schema: ${doc.typeCount} types, fetched ${new Date(doc.fetchedAt).toLocaleString()}` : 'No schema yet: fetch it for autocompletion and docs';

  return (
    <div className="flex flex-col h-full gap-1.5" data-testid="graphql-editor">
      <div className="flex items-center gap-2 text-xs min-w-0">
        {named.length > 1 && (
          <Select value={body.operationName ?? ''} onChange={(e) => onChange({ ...body, operationName: e.target.value || undefined })} className="h-7 text-xs w-44" title="Operation to run">
            <option value="">Operation: first</option>
            {named.map((op) => (
              <option key={op.name!.value} value={op.name!.value}>
                {op.operation} {op.name!.value}
              </option>
            ))}
          </Select>
        )}
        <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={prettify} title="Format the query and variables">
          Prettify
        </Button>
        <div className="flex-1" />
        <span className="text-muted truncate" data-testid="graphql-schema-status">
          {status}
        </span>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={fetching} onClick={() => void fetchSchema()} title="Run the introspection query against this URL with these headers and auth">
          {doc ? 'Refresh schema' : 'Fetch schema'}
        </Button>
        <Button size="sm" variant="ghost" icon={<BookOpen className="size-3.5" />} onClick={() => openSchemaTab(request)} title="Browse the schema">
          Docs
        </Button>
      </div>
      <div className="flex-1 min-h-[80px]" data-testid="graphql-query">
        <CodeEditor value={body.query} onChange={(query) => onChange({ ...body, query })} language="graphql" graphqlSchema={schema} placeholder={'query {\n  \n}'} />
      </div>
      <div className="flex flex-col h-24 shrink-0 gap-1">
        <Label>Variables (JSON)</Label>
        <div className="flex-1 min-h-0" data-testid="graphql-variables">
          <CodeEditor value={body.variables} onChange={(variables) => onChange({ ...body, variables })} language="json" placeholder={'{\n  "id": "1"\n}'} />
        </div>
      </div>
    </div>
  );
}
