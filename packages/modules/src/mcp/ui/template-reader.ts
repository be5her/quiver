import { Component, booleanAttribute, computed, input, linkedSignal, output } from '@angular/core';
import { expandUriTemplate, templateVariables, type McpResourceTemplate } from '@quiver/core';
import { Badge, Button, Input, Label } from '@quiver/ui';
import { McpReadResult, type ReadState } from './read-result';

/** A resource template: fill in its variables (or type the URI) and read what it expands to. */
@Component({
  selector: 'q-mcp-template-reader',
  imports: [Badge, Button, Input, Label, McpReadResult],
  template: `
    @let t = template();
    <div class="flex items-center gap-2 flex-wrap">
      <span class="text-sm font-medium">{{ t.title ?? t.name }}</span>
      <span qBadge>template</span>
      @if (t.mimeType) {
        <span qBadge>{{ t.mimeType }}</span>
      }
    </div>
    @if (t.description) {
      <p class="text-xs text-muted">{{ t.description }}</p>
    }
    <div class="grid grid-cols-2 gap-2 max-w-2xl">
      @for (name of variables(); track name) {
        <div>
          <label qLabel>{{ name }}</label>
          <input qInput [value]="values()[name] ?? ''" class="font-mono" data-testid="mcp-template-variable" (input)="setValue(name, $event)" />
        </div>
      }
    </div>
    <div class="flex items-end gap-2 max-w-2xl">
      <div class="flex-1">
        <label qLabel>URI</label>
        <input qInput [value]="target()" class="font-mono" (input)="setUri($event)" (keydown.enter)="readUri.emit(target())" />
      </div>
      <button qButton variant="primary" [loading]="busy()" data-testid="mcp-resource-read" (click)="readUri.emit(target())">Read</button>
    </div>
    <q-mcp-read-result [read]="read()" [busy]="busy()" />
  `,
  host: { class: 'flex flex-col gap-3 p-3' },
})
export class McpTemplateReader {
  readonly template = input.required<McpResourceTemplate>();
  readonly busy = input(false, { transform: booleanAttribute });
  readonly read = input<ReadState | null>(null);
  readonly readUri = output<string>();

  private readonly uriTemplate = computed(() => this.template().uriTemplate);
  protected readonly variables = computed(() => templateVariables(this.uriTemplate()));
  /** Another template starts empty again. */
  protected readonly values = linkedSignal<string, Record<string, string>>({ source: this.uriTemplate, computation: () => ({}) });
  private readonly typedUri = linkedSignal<string, string>({ source: this.uriTemplate, computation: (t) => expandUriTemplate(t, {}) });
  /** Typing in the URI field takes over from the variables until a variable is changed again. */
  private readonly touched = linkedSignal<string, boolean>({ source: this.uriTemplate, computation: () => false });
  protected readonly target = computed(() => (this.touched() ? this.typedUri() : expandUriTemplate(this.uriTemplate(), this.values())));

  protected setValue(name: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.values.update((v) => ({ ...v, [name]: value }));
    this.touched.set(false);
  }

  protected setUri(event: Event): void {
    this.typedUri.set((event.target as HTMLInputElement).value);
    this.touched.set(true);
  }
}
