import { Component, computed, inject, input, model, output } from '@angular/core';
import { CODE_TARGETS, type ApiRequest, type CodeTarget } from '@quiver/core';
import { Button, CodeEditor, IconButton, Icon, Select, Toasts, invokeResource } from '@quiver/ui';
import { Copy, X } from 'lucide';

/**
 * The request as code, in the lower pane: a language or tool to pick, the snippet for the request as
 * it stands (unsaved edits too, inheritance and variables applied), and Copy.
 */
@Component({
  selector: 'q-code-view',
  imports: [Button, CodeEditor, Icon, IconButton, Select],
  templateUrl: './code-view.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class CodeView {
  private readonly toasts = inject(Toasts);

  readonly request = input.required<ApiRequest>();
  readonly target = model<CodeTarget>('curl');
  readonly closed = output<void>();

  protected readonly targets = CODE_TARGETS;
  protected readonly icons = { Copy, X };
  protected readonly snippet = invokeResource<{ code: string }>('api.export.code', () => ({ request: this.request(), target: this.target() }));
  protected readonly language = computed(() => CODE_TARGETS.find((t) => t.value === this.target())?.language ?? 'text');

  protected setTarget(event: Event): void {
    this.target.set((event.target as HTMLSelectElement).value as CodeTarget);
  }

  protected copy(): void {
    const code = this.snippet.value()?.code;
    if (code) this.toasts.copy(code);
  }
}
