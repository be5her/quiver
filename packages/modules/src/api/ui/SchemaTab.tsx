import { toErrorPayload, type ApiRequest, type GraphqlSchemaDoc } from '@quiver/core';
import { Button, CodeEditor, EmptyState, Input, Segmented, Spinner, cn, invoke, notify, type TabProps } from '@quiver/ui';
import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLNamedType,
  type GraphQLSchema,
} from 'graphql';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { schemaFromDoc } from './GraphqlEditor';

type View = 'explore' | 'sdl';

interface Group {
  title: string;
  types: GraphQLNamedType[];
}

function groupTypes(schema: GraphQLSchema): Group[] {
  const roots = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].filter((t): t is NonNullable<typeof t> => Boolean(t));
  const rootNames = new Set(roots.map((t) => t.name));
  const rest = Object.values(schema.getTypeMap())
    .filter((t) => !t.name.startsWith('__') && !rootNames.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups: Group[] = [{ title: 'Roots', types: roots }];
  const pick = (title: string, test: (t: GraphQLNamedType) => boolean) => {
    const types = rest.filter(test);
    if (types.length) groups.push({ title, types });
  };
  pick('Objects', isObjectType);
  pick('Interfaces', isInterfaceType);
  pick('Unions', isUnionType);
  pick('Enums', isEnumType);
  pick('Inputs', isInputObjectType);
  pick('Scalars', isScalarType);
  return groups;
}

function kindOf(type: GraphQLNamedType): string {
  if (isObjectType(type)) return 'type';
  if (isInterfaceType(type)) return 'interface';
  if (isUnionType(type)) return 'union';
  if (isEnumType(type)) return 'enum';
  if (isInputObjectType(type)) return 'input';
  return 'scalar';
}

export function SchemaTab({ tab }: TabProps) {
  const requestId = String(tab.data?.id ?? '');
  const [doc, setDoc] = useState<GraphqlSchemaDoc | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [view, setView] = useState<View>('explore');
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    try {
      setDoc(await invoke<GraphqlSchemaDoc | null>('api.graphql.schema', { requestId }));
      setError(null);
    } catch (err) {
      setError(toErrorPayload(err).message);
      setDoc(null);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const refresh = async () => {
    setFetching(true);
    try {
      const request = await invoke<ApiRequest>('api.request.get', { id: requestId });
      setDoc(await invoke<GraphqlSchemaDoc>('api.graphql.introspect', { request }));
      setError(null);
      notify('Schema refreshed', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    } finally {
      setFetching(false);
    }
  };

  const schema = useMemo(() => schemaFromDoc(doc ?? null), [doc]);
  const groups = useMemo(() => (schema ? groupTypes(schema) : []), [schema]);
  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? groups.map((g) => ({ ...g, types: g.types.filter((t) => t.name.toLowerCase().includes(needle)) })).filter((g) => g.types.length) : groups),
    [groups, needle],
  );
  const current = schema && selected ? schema.getType(selected) : null;
  const first = groups[0]?.types[0]?.name ?? null;
  const shown = current ?? (schema && first ? schema.getType(first) : null);

  if (doc === undefined)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  if (error) return <div className="p-4 text-sm text-danger">{error}</div>;
  if (!doc || !schema)
    return (
      <EmptyState
        title={doc ? 'The cached schema could not be parsed' : 'No schema fetched yet'}
        hint="Run the introspection query against the request's URL with its headers and auth."
        action={
          <Button variant="primary" loading={fetching} onClick={() => void refresh()}>
            Fetch schema
          </Button>
        }
      />
    );

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="graphql-schema-tab">
      <div className="flex items-center gap-3 px-3 h-9 border-b border-edge text-xs shrink-0 min-w-0">
        <span className="font-mono truncate" title={doc.url}>
          {doc.url}
        </span>
        <span className="text-muted shrink-0">{doc.typeCount} types</span>
        <span className="text-muted shrink-0">fetched {new Date(doc.fetchedAt).toLocaleString()}</span>
        <div className="flex-1" />
        <Segmented<View>
          value={view}
          onChange={setView}
          className="border-b-0"
          options={[
            { value: 'explore', label: 'Explore' },
            { value: 'sdl', label: 'SDL' },
          ]}
        />
        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={fetching} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      {view === 'sdl' ? (
        <div className="flex-1 min-h-0 p-2">
          <CodeEditor value={doc.sdl} readOnly language="graphql" />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="w-60 border-r border-edge flex flex-col min-h-0 shrink-0">
            <div className="p-2 border-b border-edge shrink-0">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a type" className="h-7 text-xs" />
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {visible.map((group) => (
                <div key={group.title} className="mb-1">
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{group.title}</div>
                  {group.types.map((t) => (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => setSelected(t.name)}
                      className={cn('w-full text-left px-3 h-7 text-xs font-mono hover:bg-elevated truncate', shown?.name === t.name && 'bg-elevated')}
                      data-testid="graphql-type"
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              ))}
              {visible.length === 0 && <p className="px-3 py-2 text-xs text-muted">No type matches.</p>}
            </div>
          </div>
          <div className="flex-1 min-w-0 overflow-y-auto p-3">{shown ? <TypeDetail type={shown} schema={schema} onNavigate={setSelected} /> : <EmptyState title="Pick a type" />}</div>
        </div>
      )}
    </div>
  );
}

function TypeLink({ text, onNavigate }: { text: string; onNavigate(name: string): void }) {
  const name = text.replace(/[[\]!]/g, '');
  return (
    <button type="button" className="font-mono text-accent hover:underline" onClick={() => onNavigate(name)}>
      {text}
    </button>
  );
}

function Args({ args, onNavigate }: { args: readonly GraphQLArgument[]; onNavigate(name: string): void }) {
  if (!args.length) return null;
  return (
    <span className="text-muted">
      (
      {args.map((a, i) => (
        <span key={a.name}>
          {i > 0 && ', '}
          <span className="font-mono text-fg">{a.name}</span>: <TypeLink text={a.type.toString()} onNavigate={onNavigate} />
          {a.defaultValue !== undefined && <span className="text-muted"> = {JSON.stringify(a.defaultValue)}</span>}
        </span>
      ))}
      )
    </span>
  );
}

function TypeDetail({ type, schema, onNavigate }: { type: GraphQLNamedType; schema: GraphQLSchema; onNavigate(name: string): void }) {
  const kind = kindOf(type);
  const fields = isObjectType(type) || isInterfaceType(type) || isInputObjectType(type) ? Object.values(type.getFields()) : [];
  const interfaces = isObjectType(type) || isInterfaceType(type) ? type.getInterfaces() : [];
  const possible = isInterfaceType(type) || isUnionType(type) ? schema.getPossibleTypes(type) : [];
  const values = isEnumType(type) ? type.getValues() : [];
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="graphql-type-detail">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-muted">{kind}</span>
          <span className="font-mono text-base font-semibold">{type.name}</span>
          {interfaces.length > 0 && (
            <span className="text-muted">
              implements{' '}
              {interfaces.map((i, n) => (
                <span key={i.name}>
                  {n > 0 && ' & '}
                  <TypeLink text={i.name} onNavigate={onNavigate} />
                </span>
              ))}
            </span>
          )}
        </div>
        {type.description && <p className="text-muted mt-1 whitespace-pre-wrap">{type.description}</p>}
      </div>
      {fields.length > 0 && (
        <table className="w-full">
          <tbody>
            {fields.map((f) => (
              <tr key={f.name} className="border-t border-edge/60 align-top">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className={cn('font-mono', f.deprecationReason && 'line-through text-muted')}>{f.name}</span>
                  {'args' in f && <Args args={f.args} onNavigate={onNavigate} />}
                  : <TypeLink text={f.type.toString()} onNavigate={onNavigate} />
                </td>
                <td className="py-1.5 text-muted w-1/2">
                  {f.description}
                  {f.deprecationReason && <span className="text-warning"> Deprecated: {f.deprecationReason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {values.length > 0 && (
        <table className="w-full">
          <tbody>
            {values.map((v) => (
              <tr key={v.name} className="border-t border-edge/60 align-top">
                <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{v.name}</td>
                <td className="py-1.5 text-muted w-1/2">
                  {v.description}
                  {v.deprecationReason && <span className="text-warning"> Deprecated: {v.deprecationReason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {possible.length > 0 && (
        <div>
          <div className="text-muted mb-1">{isUnionType(type) ? 'Members' : 'Implemented by'}</div>
          <div className="flex flex-wrap gap-2">
            {possible.map((p) => (
              <TypeLink key={p.name} text={p.name} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      )}
      {isScalarType(type) && type.specifiedByURL && (
        <p className="text-muted">
          Specified by <span className="font-mono">{type.specifiedByURL}</span>
        </p>
      )}
      {fields.length === 0 && values.length === 0 && possible.length === 0 && !isScalarType(type) && <p className="text-muted">Nothing more to show for {getNamedType(type).name}.</p>}
    </div>
  );
}
