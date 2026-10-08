import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { toErrorPayload } from '@quiver/core';
import { Button, Checkbox, CodeEditor, HostBridge, Select, type Tab, type TabComponent } from '@quiver/ui';
import { TOOLS, coerce, type ToolOption, type ToolSummary } from './tools';

type OptionValue = string | boolean | number;

/** One converter: the input on the left, the output on the right, options in the header. */
@Component({
  selector: 'q-tool-tab',
  imports: [Button, Checkbox, CodeEditor, Select],
  templateUrl: './tool-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class ToolTab implements TabComponent {
  private readonly host = inject(HostBridge);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly tool = computed(() => TOOLS.find((t) => t.id === this.tab().data?.['id']));
  protected readonly input = signal('');
  protected readonly second = signal('');
  protected readonly options = linkedSignal<Record<string, OptionValue>>(() => Object.fromEntries((this.tool()?.options ?? []).map((o) => [o.key, o.default])));
  protected readonly output = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly summary = signal<ToolSummary | null>(null);
  protected readonly running = signal(false);
  protected readonly outputLanguage = computed(() => {
    const output = this.output();
    return this.tool()?.outputLanguage ?? (output.startsWith('{') || output.startsWith('[') ? 'json' : 'text');
  });

  constructor() {
    // Live tools run shortly after every change to the inputs or the options.
    effect((onCleanup) => {
      this.input();
      this.second();
      this.options();
      if (!untracked(this.tool)?.live) return;
      const timer = setTimeout(() => void this.run(), 150);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected setOption(option: ToolOption, value: OptionValue): void {
    this.options.update((options) => ({ ...options, [option.key]: value }));
  }

  protected isOn(option: ToolOption): boolean {
    return Boolean(this.options()[option.key]);
  }

  protected valueOf(option: ToolOption): string {
    return String(this.options()[option.key]);
  }

  protected number(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected async run(): Promise<void> {
    const tool = this.tool();
    if (!tool) return;
    const input = this.input();
    if (tool.inputKey && !input.trim()) {
      this.output.set('');
      this.error.set(null);
      this.summary.set(null);
      return;
    }
    const second = tool.secondInput && this.second().trim() ? tool.secondInput : null;
    this.running.set(true);
    try {
      const payload: Record<string, unknown> = { ...coerce(this.options(), tool.options ?? []) };
      if (tool.inputKey) payload[tool.inputKey] = input;
      if (second) payload[second.key] = this.second();
      const result = await this.host.invoke<{ text?: string } | Record<string, unknown>>(second?.commandId ?? tool.commandId, payload, null);
      this.output.set(typeof result === 'object' && result && 'text' in result && typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2));
      this.summary.set(tool.summary && typeof result === 'object' && result ? tool.summary(result as Record<string, unknown>) : null);
      this.error.set(null);
    } catch (err) {
      this.error.set(toErrorPayload(err).message);
      this.summary.set(null);
    } finally {
      this.running.set(false);
    }
  }
}
