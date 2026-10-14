import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { DbSchemaMatch } from '@quiver/core';
import { Autofocus, EmptyState, Icon, Input, Spinner, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Columns3, Search, Table2 } from 'lucide';
import { DbActions } from './db-actions';
import { KindIcon } from './kind-icon';

interface SearchResult {
  matches: DbSchemaMatch[];
  errors: { connectionId: string; connectionName: string; message: string }[];
}

interface Group {
  key: string;
  connectionName: string;
  kind: DbSchemaMatch['kind'];
  database: string | null;
  matches: DbSchemaMatch[];
}

/** Find a table or a column by name across every SQL connection of the workspace; a hit opens its table. */
@Component({
  selector: 'q-db-search-tab',
  imports: [Autofocus, EmptyState, Icon, Input, KindIcon, Spinner],
  templateUrl: './search-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class SearchTab implements TabComponent {
  private readonly db = inject(DbActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Columns3, Search, Table2 };
  protected readonly query = signal('');
  /** The query, settled: what the host is asked for. */
  private readonly debounced = signal('');
  protected readonly results = invokeResource<SearchResult>('db.schema.search', () => ({ query: this.debounced(), limit: 300 }), {
    enabled: () => this.debounced().trim().length > 0,
    refreshOn: ['db-connections'],
  });
  protected readonly groups = computed<Group[]>(() => {
    const groups = new Map<string, Group>();
    for (const m of this.results.value()?.matches ?? []) {
      const key = `${m.connectionId}/${m.database ?? ''}`;
      const group = groups.get(key) ?? { key, connectionName: m.connectionName, kind: m.kind, database: m.database, matches: [] };
      group.matches.push(m);
      groups.set(key, group);
    }
    return [...groups.values()];
  });
  protected readonly total = computed(() => this.results.value()?.matches.length ?? 0);

  constructor() {
    // A query handed in from outside (the palette, a connection's menu) lands in the box.
    effect(() => {
      const initial = this.tab().data?.['query'];
      if (typeof initial === 'string' && initial) untracked(() => this.query.set(initial));
    });
    effect((onCleanup) => {
      const value = this.query();
      const timer = setTimeout(() => this.debounced.set(value), 250);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected typed(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected open(match: DbSchemaMatch): void {
    this.db.openTableTab(match.connectionId, match.table, match.kind === 'sqlite' ? null : match.database);
  }
}
