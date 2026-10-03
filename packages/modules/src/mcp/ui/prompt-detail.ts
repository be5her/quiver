import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { toErrorPayload, type McpPrompt, type McpPromptResult, type McpServerSummary } from '@quiver/core';
import { Badge, Button, HostBridge, Input, Label, Toasts, formatMs } from '@quiver/ui';
import { Play } from 'lucide';
import { McpContentBlock } from './content';

interface GetState {
  result: (McpPromptResult & { durationMs: number }) | null;
  error: string | null;
}

/** One prompt: its arguments, and the messages it renders to. */
@Component({
  selector: 'q-mcp-prompt-detail',
  imports: [Badge, Button, Input, Label, McpContentBlock],
  template: `
    @let p = prompt();
    <div class="flex items-center gap-2 flex-wrap">
      <span class="font-mono text-sm font-medium">{{ p.name }}</span>
      @if (p.title) {
        <span class="text-xs text-muted">{{ p.title }}</span>
      }
      <div class="flex-1"></div>
      <button qButton size="sm" variant="primary" [icon]="play" [loading]="busy()" data-testid="mcp-prompt-get" (click)="get()">Get prompt</button>
    </div>
    @if (p.description) {
      <p class="text-xs text-muted whitespace-pre-wrap">{{ p.description }}</p>
    }
    @if (args().length > 0) {
      <div class="grid grid-cols-2 gap-2 max-w-2xl">
        @for (a of args(); track a.name) {
          <div>
            <label qLabel>{{ a.name }}{{ a.required ? ' *' : '' }}</label>
            <input qInput [value]="values()[a.name] ?? ''" [placeholder]="a.description ?? ''" data-testid="mcp-prompt-argument" (input)="setValue(a.name, $event)" (keydown.enter)="get()" />
          </div>
        }
      </div>
    }
    @if (state(); as s) {
      <div class="flex flex-col gap-2" data-testid="mcp-prompt-result">
        @if (s.error) {
          <p class="text-xs text-danger whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5">{{ s.error }}</p>
        }
        @if (s.result; as result) {
          <span class="text-[11px] text-muted">{{ result.messages.length }} message{{ result.messages.length === 1 ? '' : 's' }} · {{ formatMs(result.durationMs) }}{{ result.description ? ' · ' + result.description : '' }}</span>
          @for (m of result.messages; track $index) {
            <div class="rounded-md border border-edge p-2 flex flex-col gap-1">
              <span qBadge class="self-start" [class]="m.role === 'user' ? 'text-sky-600 dark:text-sky-400' : 'text-violet-600 dark:text-violet-400'">{{ m.role }}</span>
              <q-mcp-content-block [content]="m.content" />
            </div>
          }
        }
      </div>
    }
  `,
  host: { class: 'flex flex-col gap-3 p-3' },
})
export class McpPromptDetail {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly server = input.required<McpServerSummary>();
  readonly prompt = input.required<McpPrompt>();

  protected readonly play = Play;
  protected readonly formatMs = formatMs;
  private readonly name = computed(() => this.prompt().name);
  protected readonly args = computed(() => this.prompt().arguments ?? []);
  /** Picking another prompt starts over: empty arguments, no result. */
  protected readonly values = linkedSignal<string, Record<string, string>>({ source: this.name, computation: () => ({}) });
  protected readonly state = linkedSignal<string, GetState | null>({ source: this.name, computation: () => null });
  protected readonly busy = linkedSignal<string, boolean>({ source: this.name, computation: () => false });

  protected setValue(name: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.values.update((v) => ({ ...v, [name]: value }));
  }

  protected async get(): Promise<void> {
    const values = this.values();
    const missing = this.args()
      .filter((a) => a.required && !(values[a.name] ?? '').trim())
      .map((a) => a.name);
    if (missing.length) {
      this.toasts.notify(`Required: ${missing.join(', ')}`, 'error');
      return;
    }
    const name = this.name();
    this.busy.set(true);
    try {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
      const result = await this.host.invoke<McpPromptResult & { durationMs: number }>('mcp.prompt.get', { id: this.server().id, name, arguments: filled });
      if (this.name() === name) this.state.set({ result, error: null });
    } catch (err) {
      if (this.name() === name) this.state.set({ result: null, error: toErrorPayload(err).message });
    } finally {
      if (this.name() === name) this.busy.set(false);
    }
  }
}
