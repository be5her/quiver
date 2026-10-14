import { Component, computed, inject, input, linkedSignal, resource, signal } from '@angular/core';
import { toErrorPayload, type ApiRequest, type GraphqlSchemaDoc } from '@quiver/core';
import { Button, CodeEditor, EmptyState, HostBridge, Input, Segment, Segmented, Spinner, Toasts, type Tab, type TabComponent } from '@quiver/ui';
import { isEnumType, isInputObjectType, isInterfaceType, isObjectType, isScalarType, isUnionType, type GraphQLNamedType, type GraphQLSchema } from 'graphql';
import { RefreshCw } from 'lucide';
import { schemaFromDoc } from './graphql-schema';
import { SchemaTypeDetail } from './schema-type-detail';

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

/** The schema of a request's endpoint: types grouped by kind with their fields, or the whole SDL. */
@Component({
  selector: 'q-schema-tab',
  imports: [Button, CodeEditor, EmptyState, Input, SchemaTypeDetail, Segment, Segmented, Spinner],
  templateUrl: './schema-tab.html',
  host: { class: 'contents' },
})
export class SchemaTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly refreshIcon = RefreshCw;
  private readonly requestId = computed(() => String(this.tab().data?.['id'] ?? ''));
  private readonly cached = resource({
    params: () => ({ requestId: this.requestId() }),
    loader: ({ params }) => this.host.invoke<GraphqlSchemaDoc | null>('api.graphql.schema', params),
  });
  /** The schema shown: the cached one, then whatever a refresh fetched. */
  protected readonly doc = linkedSignal<GraphqlSchemaDoc | null | undefined>(() => (this.cached.hasValue() ? this.cached.value() : this.cached.status() === 'error' ? null : undefined));
  protected readonly error = computed(() => (this.cached.status() === 'error' ? toErrorPayload(this.cached.error()).message : null));
  protected readonly fetching = signal(false);
  protected readonly view = signal<View>('explore');
  protected readonly selected = signal<string | null>(null);
  protected readonly search = signal('');
  protected readonly schema = computed(() => schemaFromDoc(this.doc()));
  private readonly groups = computed(() => {
    const schema = this.schema();
    return schema ? groupTypes(schema) : [];
  });
  protected readonly visible = computed(() => {
    const needle = this.search().trim().toLowerCase();
    const groups = this.groups();
    return needle ? groups.map((g) => ({ ...g, types: g.types.filter((t) => t.name.toLowerCase().includes(needle)) })).filter((g) => g.types.length) : groups;
  });
  /** The picked type, or the first root until one is picked. */
  protected readonly shown = computed(() => {
    const schema = this.schema();
    if (!schema) return null;
    const name = this.selected() ?? this.groups()[0]?.types[0]?.name;
    return name ? (schema.getType(name) ?? null) : null;
  });
  protected readonly fetchedAt = computed(() => {
    const doc = this.doc();
    return doc ? new Date(doc.fetchedAt).toLocaleString() : '';
  });

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected async refresh(): Promise<void> {
    this.fetching.set(true);
    try {
      const request = await this.host.invoke<ApiRequest>('api.request.get', { id: this.requestId() });
      this.doc.set(await this.host.invoke<GraphqlSchemaDoc>('api.graphql.introspect', { request }));
      this.toasts.notify('Schema refreshed', 'success');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.fetching.set(false);
    }
  }
}
