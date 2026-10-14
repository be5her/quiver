import { Component, ElementRef, afterRenderEffect, booleanAttribute, computed, inject, input, output, signal, viewChild } from '@angular/core';
import type { ErrorPayload } from '@quiver/core';
import { Badge, Checkbox, Icon, IconButton, Input, Spinner, Toasts, cn } from '@quiver/ui';
import { ChevronDown, ChevronRight, Copy, Search, X } from 'lucide';
import { DbError, formatDuration } from '../../db/ui';
import { splitMatches } from './kube-query-model';

/** The command that ran, as the host built it. */
export interface KubeRan {
  command: string;
  setup: string | null;
}

/** A run's output with its exit code and timing, searchable; a followed log scrolls along. */
@Component({
  selector: 'q-kube-output-panel',
  imports: [Badge, Checkbox, DbError, Icon, IconButton, Input, Spinner],
  templateUrl: './kube-output-panel.html',
  host: { class: 'flex-1 min-h-0 flex flex-col' },
})
export class KubeOutputPanel {
  private readonly toasts = inject(Toasts);
  private readonly scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');

  readonly lines = input.required<string[]>();
  readonly stderr = input('');
  readonly exitCode = input<number | null>();
  readonly durationMs = input<number>();
  readonly running = input<{ streaming: boolean } | null>(null);
  readonly truncated = input(false, { transform: booleanAttribute });
  readonly error = input<ErrorPayload | null>(null);
  readonly ran = input<KubeRan | null>(null);
  readonly hasResult = input(false, { transform: booleanAttribute });
  readonly retry = output<void>();

  protected readonly icons = { ChevronDown, ChevronRight, Copy, Search, X };
  protected readonly formatDuration = formatDuration;
  protected readonly search = signal('');
  protected readonly onlyMatches = signal(false);
  protected readonly follow = signal(true);
  protected readonly showCommand = signal(false);
  protected readonly term = computed(() => this.search().trim().toLowerCase());
  protected readonly matches = computed(() => {
    const term = this.term();
    return term ? this.lines().reduce((n, l) => n + (l.toLowerCase().includes(term) ? 1 : 0), 0) : 0;
  });
  protected readonly shown = computed(() => {
    const term = this.term();
    return term && this.onlyMatches() ? this.lines().filter((l) => l.toLowerCase().includes(term)) : this.lines();
  });
  /** Without a search, the output is one text node; with one, each line is split around its matches. */
  protected readonly plainText = computed(() => (this.term() ? null : this.shown().map((l) => `${l}\n`).join('')));
  protected readonly highlighted = computed(() => {
    const term = this.term();
    return term ? this.shown().map((line) => splitMatches(line, term)) : [];
  });
  protected readonly hasStderr = computed(() => Boolean(this.stderr().trim()));
  protected readonly stderrText = computed(() => this.stderr().trimEnd());
  // kubectl also writes notes such as "No resources found" to stderr on success; only a failure is shown as an error.
  protected readonly stderrClass = computed(() => cn('px-3 pt-2 text-xs font-mono whitespace-pre-wrap break-all', this.exitCode() === 0 ? 'text-muted' : 'text-danger'));
  protected readonly exitClass = computed(() => cn('font-mono', this.exitCode() === 0 ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'));

  constructor() {
    afterRenderEffect({
      write: () => {
        this.shown();
        const el = this.scroller().nativeElement;
        if (this.running()?.streaming && this.follow()) el.scrollTop = el.scrollHeight;
      },
    });
  }

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected copyOutput(): void {
    void navigator.clipboard.writeText(this.lines().join('\n')).then(() => this.toasts.notify('Output copied', 'success'));
  }

  protected copyCommand(command: string): void {
    void navigator.clipboard.writeText(command).then(() => this.toasts.notify('Command copied', 'success'));
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
