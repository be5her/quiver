import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { mcpAgentLabel, type McpRecordedCall, type McpRecordedCallSummary } from '@quiver/core';
import { Badge, Button, CodeEditor, Spinner, Toasts, formatBytes, formatMs, invokeResource } from '@quiver/ui';
import { agentColor } from './mcp-format';

const pretty = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? ''));

/** One recorded call: who made it, where, how long it took, its arguments and what the agent got back. */
@Component({
  selector: 'q-mcp-call-detail',
  imports: [Badge, Button, CodeEditor, Spinner],
  template: `
    @let s = summary();
    <div class="flex flex-col gap-1 px-3 py-2 border-b border-edge shrink-0">
      <div class="flex items-center gap-2 min-w-0">
        <span class="font-mono text-sm truncate">{{ s.tool }}</span>
        @if (s.ok === null) {
          <svg qSpinner class="size-3"></svg>
        } @else {
          <span qBadge class="shrink-0" [class]="s.ok ? 'text-success' : 'text-danger'">{{ s.ok ? 'ok' : 'failed' }}</span>
        }
      </div>
      <div class="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px] text-muted">
        <span class="font-medium" [class]="color()" [attr.title]="s.agent.userAgent">{{ agent() }}</span>
        @if (s.workspace) {
          <span [title]="s.workspace.path">in {{ s.workspace.name }}</span>
        }
        <span>{{ at() }}</span>
        @if (s.durationMs !== null) {
          <span>{{ formatMs(s.durationMs) }}</span>
        }
        <span>{{ formatBytes(s.size) }}</span>
      </div>
    </div>
    <div [class]="heading">
      <span>Arguments</span>
      <button qButton size="sm" variant="ghost" [disabled]="!call.value()" (click)="copy(args())">Copy</button>
    </div>
    <div class="px-2 max-h-[35%] overflow-y-auto shrink-0" data-testid="mcp-recorder-arguments">
      <q-code-editor [value]="args()" readonly language="json" [fill]="false" wrap />
    </div>
    <div [class]="heading">
      <span>Result</span>
      <button qButton size="sm" variant="ghost" [disabled]="!answered()" (click)="copy(result())">Copy</button>
    </div>
    <div class="flex-1 min-h-0 px-2 pb-2" data-testid="mcp-recorder-result">
      @if (call.error(); as error) {
        <p class="text-xs text-danger px-1">{{ error.message }}</p>
      } @else if (answered()) {
        <q-code-editor [value]="result()" readonly [language]="textResult() ? 'text' : 'json'" [wrap]="textResult()" />
      } @else {
        <p class="text-xs text-muted px-1 flex items-center gap-2"><svg qSpinner class="size-3"></svg> Still running…</p>
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'mcp-recorder-detail' },
})
export class McpCallDetail {
  private readonly toasts = inject(Toasts);

  readonly summary = input.required<McpRecordedCallSummary>();

  protected readonly heading = 'flex items-center justify-between px-3 h-7 text-[11px] font-semibold uppercase tracking-wide text-muted shrink-0';
  protected readonly formatBytes = formatBytes;
  protected readonly formatMs = formatMs;
  private readonly id = computed(() => this.summary().id);
  protected readonly call = invokeResource<McpRecordedCall>('mcp.recording.get', () => ({ id: this.id() }), { workspaceId: null });
  /** The summary says when a running call has answered. */
  protected readonly answered = computed(() => this.summary().ok !== null);
  protected readonly args = computed(() => {
    const call = this.call.value();
    return call ? pretty(call.arguments) : '';
  });
  protected readonly result = computed(() => {
    const call = this.call.value();
    return call && call.ok !== null ? pretty(call.result) : '';
  });
  protected readonly textResult = computed(() => typeof this.call.value()?.result === 'string');
  protected readonly agent = computed(() => mcpAgentLabel(this.summary().agent));
  protected readonly color = computed(() => agentColor(this.summary().agent.name));
  protected readonly at = computed(() => new Date(this.summary().at).toLocaleString());

  constructor() {
    // A call shown while still running is fetched again once it has answered, to get its result.
    let shown: { id: string; answered: boolean } | null = null;
    effect(() => {
      const now = { id: this.id(), answered: this.answered() };
      if (shown && shown.id === now.id && now.answered && !shown.answered) untracked(() => this.call.reload());
      shown = now;
    });
  }

  protected copy(text: string): void {
    this.toasts.copy(text);
  }
}
