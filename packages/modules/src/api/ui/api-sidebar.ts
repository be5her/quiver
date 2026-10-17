import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { historyStatusLabel, matchesHistory, matchesRequest, shortRelativeTime, type ApiCollection, type ApiRequest, type Environment, type HistoryEntry } from '@quiver/core';
import { ContextMenu, Icon, IconButton, METHOD_COLORS, SectionHeader, Toasts, TreeState, invokeResource, statusColor } from '@quiver/ui';
import { Braces, Check, ChevronDown, ChevronRight, Cookie, FolderPlus, Import, Plus, Search, Trash2, X } from 'lucide';
import { ApiActions } from './api-actions';
import { ApiCollectionTree } from './api-collection-tree';
import { ApiRow } from './api-row';
import { ApiTreeDrag, ROOT_TARGET } from './api-tree-drag';

/** How many history entries the sidebar shows; the rest are in the history tab. */
const SIDEBAR_HISTORY = 30;

/**
 * Collections with their requests (draggable, with menus), the environments (with the active one
 * ticked) and the latest requests sent. One filter box narrows the tree and the history.
 */
@Component({
  selector: 'q-api-sidebar',
  imports: [ApiCollectionTree, ApiRow, Icon, IconButton, SectionHeader],
  providers: [ApiTreeDrag],
  templateUrl: './api-sidebar.html',
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class ApiSidebar {
  private readonly tree = inject(TreeState);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);
  protected readonly api = inject(ApiActions);
  protected readonly drag = inject(ApiTreeDrag);

  protected readonly icons = { Braces, Check, ChevronDown, ChevronRight, Cookie, FolderPlus, Import, Plus, Search, Trash2, X };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly baseUrlSyntax = '{{baseUrl}}';
  protected readonly rootTarget = ROOT_TARGET;
  protected readonly statusColor = statusColor;
  protected readonly statusLabel = historyStatusLabel;
  protected readonly requests = invokeResource<ApiRequest[]>('api.request.list', () => ({}), { refreshOn: ['requests'] });
  protected readonly collections = invokeResource<ApiCollection[]>('api.collection.list', () => ({}), { refreshOn: ['collections'] });
  protected readonly environments = invokeResource<Environment[]>('api.environment.list', () => ({}), { refreshOn: ['environments'] });
  protected readonly active = invokeResource<{ id: string | null }>('api.environment.active', () => ({}), { refreshOnState: ['api.activeEnvironment'] });
  /** One more than the sidebar shows, to know whether "Show all" has anything more to show. */
  protected readonly history = invokeResource<HistoryEntry[]>('api.history.list', () => ({ limit: SIDEBAR_HISTORY + 1 }), { refreshOn: ['history'] });
  protected readonly activeId = computed(() => this.active.value()?.id ?? null);
  protected readonly empty = computed(() => !this.requests.value()?.length && !this.collections.value()?.length);
  protected readonly envOpen = computed(() => this.tree.isExpanded('api/section/environments', true));
  protected readonly historyOpen = computed(() => this.tree.isExpanded('api/section/history'));

  /** Narrows the tree (name, method, URL) and the history (method, URL, name, status). */
  protected readonly filter = signal('');
  protected readonly filtering = computed(() => this.filter().trim().length > 0);
  protected readonly noMatches = computed(() => this.filtering() && !(this.requests.value() ?? []).some((r) => matchesRequest(r, this.filter())));
  protected readonly shownHistory = computed(() => {
    const entries = (this.history.value() ?? []).slice(0, SIDEBAR_HISTORY);
    return this.filtering() ? entries.filter((e) => matchesHistory(e, this.filter())) : entries;
  });
  protected readonly moreHistory = computed(() => (this.history.value()?.length ?? 0) > SIDEBAR_HISTORY);

  /** The clock the history's "3m" ages are read against, moved on every half minute. */
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    // The drag needs the tree's contents to decide where an item may go.
    effect(() => {
      this.drag.collections.set(this.collections.value() ?? []);
      this.drag.requests.set(this.requests.value() ?? []);
    });
  }

  protected setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected clearFilter(input?: HTMLInputElement): void {
    this.filter.set('');
    if (input) input.value = '';
  }

  protected filterKey(event: KeyboardEvent, input: HTMLInputElement): void {
    if (event.key === 'Escape' && this.filter()) {
      event.stopPropagation();
      this.clearFilter(input);
    }
  }

  protected toggleEnvironments(): void {
    this.tree.toggle('api/section/environments', true);
  }

  protected toggleHistory(): void {
    this.tree.toggle('api/section/history');
  }

  /** The check before an environment: activates it, or deactivates the active one. */
  protected toggleActive(event: MouseEvent, env: Environment): void {
    event.stopPropagation();
    void this.api.setActiveEnvironment(this.activeId() === env.id ? null : env.id);
  }

  protected deleteEnvironment(event: MouseEvent, env: Environment): void {
    event.stopPropagation();
    this.api.deleteEnvironment(env).catch((err) => this.toasts.error(err));
  }

  protected replay(entry: HistoryEntry): void {
    this.api.openHistoryEntry(entry);
  }

  protected historyMenu(event: MouseEvent, entry: HistoryEntry): void {
    this.contextMenu.open(event, [
      { label: 'Open', select: () => this.api.openHistoryEntry(entry) },
      { label: 'Save as request', select: () => this.api.saveHistoryEntry(entry).catch((err) => this.toasts.error(err)), testId: 'api-history-save' },
      { label: 'Copy URL', select: () => this.toasts.copy(entry.url) },
      'separator',
      { label: 'Show all history', select: () => this.api.openHistoryTab() },
    ]);
  }

  protected age(entry: HistoryEntry): string {
    return shortRelativeTime(Date.parse(entry.at) - this.now());
  }

  protected cancelled(entry: HistoryEntry): boolean {
    return entry.status === null && entry.error === 'Cancelled';
  }

  protected entryTitle(entry: HistoryEntry): string {
    return [new Date(entry.at).toLocaleString(), entry.url, entry.error].filter(Boolean).join('\n');
  }

  protected shortUrl(url: string): string {
    return url.replace(/^https?:\/\//, '');
  }
}
