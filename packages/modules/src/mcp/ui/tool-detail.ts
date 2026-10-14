import { Component, booleanAttribute, computed, inject, input, linkedSignal, model, output } from '@angular/core';
import type { McpTool, McpToolCallOutcome } from '@quiver/core';
import { Badge, Button, CodeEditor, Toasts, formatMs } from '@quiver/ui';
import { Copy, Play } from 'lucide';
import { McpContentBlocks, McpTextBlock } from './content';

export interface CallState {
  at: string;
  outcome: McpToolCallOutcome | null;
  error: string | null;
}

/** One tool: its description, annotations and schemas, the arguments to call it with, and the last result. */
@Component({
  selector: 'q-mcp-tool-detail',
  imports: [Badge, Button, CodeEditor, McpContentBlocks, McpTextBlock],
  templateUrl: './tool-detail.html',
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'mcp-tool-detail' },
})
export class McpToolDetail {
  private readonly toasts = inject(Toasts);

  readonly tool = input.required<McpTool>();
  readonly args = model.required<string>();
  readonly state = input<CallState | null>(null);
  readonly busy = input(false, { transform: booleanAttribute });
  readonly call = output<void>();

  protected readonly icons = { Copy, Play };
  protected readonly formatMs = formatMs;
  /** Picking another tool hides the schema again. */
  protected readonly showSchema = linkedSignal<string, boolean>({ source: () => this.tool().name, computation: () => false });
  protected readonly annotations = computed(() => {
    const a = this.tool().annotations ?? {};
    return [a.readOnlyHint && 'read-only', a.destructiveHint && 'destructive', a.idempotentHint && 'idempotent', a.openWorldHint && 'open world'].filter((x): x is string => Boolean(x));
  });
  protected readonly hasArgs = computed(() => Object.keys(this.tool().inputSchema.properties ?? {}).length > 0);
  protected readonly inputSchema = computed(() => JSON.stringify(this.tool().inputSchema, null, 2));
  protected readonly outputSchema = computed(() => {
    const schema = this.tool().outputSchema;
    return schema ? JSON.stringify(schema, null, 2) : null;
  });
  protected readonly structured = computed(() => {
    const content = this.state()?.outcome?.result.structuredContent;
    return content ? JSON.stringify(content, null, 2) : null;
  });
  protected readonly at = computed(() => {
    const state = this.state();
    return state ? new Date(state.at).toLocaleTimeString() : '';
  });

  protected annotationClass(annotation: string): string {
    return annotation === 'destructive' ? 'text-danger' : annotation === 'read-only' ? 'text-success' : '';
  }

  protected copyResult(): void {
    const outcome = this.state()?.outcome;
    if (outcome) this.toasts.copy(JSON.stringify(outcome.result, null, 2));
  }
}
