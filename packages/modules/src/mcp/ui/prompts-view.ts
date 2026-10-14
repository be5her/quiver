import { Component, computed, inject, input, signal } from '@angular/core';
import type { McpPrompt, McpServerSummary } from '@quiver/core';
import { Button, EmptyState, HostBridge, Icon, Input, Spinner, Toasts } from '@quiver/ui';
import { MessageSquare, RefreshCw } from 'lucide';
import { McpPromptDetail } from './prompt-detail';
import { injectServerQuery } from './server-query';

/** The prompts of a connected server, and the one being rendered. */
@Component({
  selector: 'q-mcp-prompts-view',
  imports: [Button, EmptyState, Icon, Input, McpPromptDetail, Spinner],
  template: `
    @if (server().status !== 'connected') {
      <q-empty-state title="Not connected" hint="Connect to list the prompts of this server." />
    } @else {
      <div class="flex h-full min-h-0">
        <div class="w-64 border-r border-edge flex flex-col min-h-0 shrink-0">
          <div class="flex items-center gap-1 px-2 h-9 border-b border-edge shrink-0">
            <input qInput [value]="filter()" (input)="typed($event)" placeholder="Filter prompts" class="h-7 text-xs" />
            <button qButton size="sm" variant="ghost" [icon]="icons.RefreshCw" title="Ask the server for its prompts again" (click)="refresh()"></button>
          </div>
          <div class="flex-1 overflow-y-auto">
            @if (prompts.isLoading() && !prompts.value()) {
              <div class="px-3 py-2"><svg qSpinner></svg></div>
            }
            @for (p of filtered(); track p.name) {
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 border-b border-edge/60 hover:bg-elevated flex items-start gap-2 min-w-0"
                [class.bg-elevated]="p.name === selectedName()"
                data-testid="mcp-prompt"
                (click)="selectedName.set(p.name)"
              >
                <svg [qIcon]="icons.MessageSquare" class="size-3.5 text-muted shrink-0 mt-0.5"></svg>
                <span class="flex flex-col min-w-0 flex-1">
                  <span class="font-mono text-xs truncate">{{ p.name }}</span>
                  @if (p.title || p.description) {
                    <span class="text-[11px] text-muted truncate">{{ p.title ?? p.description }}</span>
                  }
                </span>
              </button>
            }
            @if (prompts.value() && list().length === 0) {
              <p class="px-3 py-3 text-xs text-muted">This server has no prompts.</p>
            }
          </div>
        </div>
        <div class="flex-1 min-w-0 min-h-0 overflow-y-auto">
          @if (selected(); as prompt) {
            <q-mcp-prompt-detail [server]="server()" [prompt]="prompt" />
          } @else {
            <q-empty-state title="Pick a prompt" hint="Fill in its arguments and render it to see the messages an agent would receive." />
          }
        </div>
      </div>
    }
  `,
  host: { class: 'contents' },
})
export class McpPromptsView {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly server = input.required<McpServerSummary>();

  protected readonly icons = { MessageSquare, RefreshCw };
  protected readonly prompts = injectServerQuery<McpPrompt[]>('mcp.prompt.list', () => ({ id: this.server().id }), this.server, ['lists', 'status']);
  protected readonly selectedName = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly list = computed(() => this.prompts.value() ?? []);
  protected readonly filtered = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    return needle ? this.list().filter((p) => `${p.name} ${p.title ?? ''} ${p.description ?? ''}`.toLowerCase().includes(needle)) : this.list();
  });
  protected readonly selected = computed(() => this.list().find((p) => p.name === this.selectedName()) ?? null);

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected async refresh(): Promise<void> {
    try {
      await this.host.invoke('mcp.prompt.list', { id: this.server().id, refresh: true });
      this.prompts.reload();
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
