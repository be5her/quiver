import { Component, computed, inject } from '@angular/core';
import type { ApiCollection, ApiRequest, Environment, HistoryEntry } from '@quiver/core';
import { Icon, IconButton, METHOD_COLORS, SectionHeader, Toasts, TreeState, invokeResource, statusColor } from '@quiver/ui';
import { Braces, Check, ChevronDown, ChevronRight, FolderPlus, Import, Plus, Trash2 } from 'lucide';
import { ApiActions } from './api-actions';
import { ApiCollectionTree } from './api-collection-tree';
import { ApiRow } from './api-row';

/** Collections with their requests, the environments (with the active one ticked) and the request history. */
@Component({
  selector: 'q-api-sidebar',
  imports: [ApiCollectionTree, ApiRow, Icon, IconButton, SectionHeader],
  templateUrl: './api-sidebar.html',
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class ApiSidebar {
  private readonly tree = inject(TreeState);
  private readonly toasts = inject(Toasts);
  protected readonly api = inject(ApiActions);

  protected readonly icons = { Braces, Check, ChevronDown, ChevronRight, FolderPlus, Import, Plus, Trash2 };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly baseUrlSyntax = '{{baseUrl}}';
  protected readonly statusColor = statusColor;
  protected readonly requests = invokeResource<ApiRequest[]>('api.request.list', () => ({}), { refreshOn: ['requests'] });
  protected readonly collections = invokeResource<ApiCollection[]>('api.collection.list', () => ({}), { refreshOn: ['collections'] });
  protected readonly environments = invokeResource<Environment[]>('api.environment.list', () => ({}), { refreshOn: ['environments'] });
  protected readonly active = invokeResource<{ id: string | null }>('api.environment.active', () => ({}), { refreshOnState: ['api.activeEnvironment'] });
  protected readonly history = invokeResource<HistoryEntry[]>('api.history.list', () => ({ limit: 30 }), { refreshOn: ['history'] });
  protected readonly activeId = computed(() => this.active.value()?.id ?? null);
  protected readonly empty = computed(() => !this.requests.value()?.length && !this.collections.value()?.length);
  protected readonly envOpen = computed(() => this.tree.isExpanded('api/section/environments', true));
  protected readonly historyOpen = computed(() => this.tree.isExpanded('api/section/history'));

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

  /** A past request opens as an unsaved draft. */
  protected replay(entry: HistoryEntry): void {
    this.api.openRequestTab({ id: `history-${entry.id}`, name: entry.request.name }, { ...entry.request, id: `history-${entry.id}` });
  }

  protected shortUrl(url: string): string {
    return url.replace(/^https?:\/\//, '');
  }
}
