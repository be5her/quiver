import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toErrorPayload, type McpReadResourceResult, type McpResource, type McpResourceTemplate, type McpServerSummary } from '@quiver/core';
import { Badge, Button, EmptyState, HostBridge, Icon, Input, Spinner, Toasts } from '@quiver/ui';
import { BookOpen, FileText, RefreshCw } from 'lucide';
import { McpReadResult, type ReadState } from './read-result';
import { injectServerQuery } from './server-query';
import { McpTemplateReader } from './template-reader';

type Lists = { resources: McpResource[]; templates: McpResourceTemplate[] };
type Selection = { kind: 'resource'; uri: string } | { kind: 'template'; uriTemplate: string };
type Listed = { name: string; title?: string; description?: string; uri?: string; uriTemplate?: string };

/** The resources and resource templates of a connected server. A resource is read as soon as it is picked. */
@Component({
  selector: 'q-mcp-resources-view',
  imports: [Badge, Button, EmptyState, Icon, Input, McpReadResult, McpTemplateReader, Spinner],
  templateUrl: './resources-view.html',
  host: { class: 'contents' },
})
export class McpResourcesView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly server = input.required<McpServerSummary>();

  protected readonly icons = { BookOpen, FileText, RefreshCw };
  protected readonly lists = injectServerQuery<Lists>('mcp.resource.list', () => ({ id: this.server().id }), this.server, ['lists', 'status']);
  protected readonly selection = signal<Selection | null>(null);
  protected readonly filter = signal('');
  protected readonly read = signal<ReadState | null>(null);
  protected readonly busy = signal(false);

  protected readonly resources = computed(() => this.lists.value()?.resources ?? []);
  protected readonly templates = computed(() => this.lists.value()?.templates ?? []);
  protected readonly shownResources = computed(() => this.resources().filter((r) => this.matches(r)));
  protected readonly shownTemplates = computed(() => this.templates().filter((t) => this.matches(t)));
  protected readonly selectedResource = computed(() => {
    const selection = this.selection();
    return selection?.kind === 'resource' ? (this.resources().find((r) => r.uri === selection.uri) ?? null) : null;
  });
  protected readonly selectedTemplate = computed(() => {
    const selection = this.selection();
    return selection?.kind === 'template' ? (this.templates().find((t) => t.uriTemplate === selection.uriTemplate) ?? null) : null;
  });
  private readonly selectedUri = computed(() => this.selectedResource()?.uri);
  protected readonly resourceRead = computed(() => {
    const read = this.read();
    return read && read.uri === this.selectedUri() ? read : null;
  });

  constructor() {
    // Reading is what picking a resource is for; only a different URI reads again.
    effect(() => {
      const uri = this.selectedUri();
      if (uri) untracked(() => void this.readUri(uri));
    });
  }

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected isSelectedResource(uri: string): boolean {
    const selection = this.selection();
    return selection?.kind === 'resource' && selection.uri === uri;
  }

  protected isSelectedTemplate(uriTemplate: string): boolean {
    const selection = this.selection();
    return selection?.kind === 'template' && selection.uriTemplate === uriTemplate;
  }

  protected async refresh(): Promise<void> {
    try {
      await this.host.invoke('mcp.resource.list', { id: this.server().id, refresh: true });
      this.lists.reload();
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async readUri(uri: string): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.host.invoke<McpReadResourceResult & { durationMs: number }>('mcp.resource.read', { id: this.server().id, uri });
      this.read.set({ uri, result, error: null });
    } catch (err) {
      this.read.set({ uri, result: null, error: toErrorPayload(err).message });
    } finally {
      this.busy.set(false);
    }
  }

  private matches(r: Listed): boolean {
    const needle = this.filter().trim().toLowerCase();
    return !needle || `${r.name} ${r.title ?? ''} ${r.description ?? ''} ${r.uri ?? r.uriTemplate ?? ''}`.toLowerCase().includes(needle);
  }
}
