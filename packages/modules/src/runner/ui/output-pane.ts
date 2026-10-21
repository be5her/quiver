import { Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { toErrorPayload, type RunnerOutputChunk, type RunnerOutputLine } from '@quiver/core';
import { Button, HostBridge, Icon, Input, Toasts } from '@quiver/ui';
import { ArrowDownToLine, CornerDownLeft, Eraser, Search, TriangleAlert } from 'lucide';
import { parseAnsi, plainText, type AnsiSpan, type AnsiStyle } from './ansi';
import { injectRunnerChanged } from './runner-events';

/** Lines kept on screen, as many as the host keeps per run. */
const KEEP = 5000;
/** Lines asked for per read; a burst is read in a few pages at most. */
const PAGE = 1000;
const PAGES = 6;

interface ShownLine {
  /** Unique on screen: the run's id and the line's sequence number. */
  key: string;
  stream: RunnerOutputLine['stream'] | 'divider';
  spans: AnsiSpan[];
  /** Lower-case text without escapes, for the search. */
  plain: string;
  at: string;
}

/**
 * A task's output, read with the cursor from `runner.proc.output` whenever `runner.changed` says there is more (at
 * most four times a second). Colour codes are drawn; the search filters the lines; follow keeps the newest in view and
 * turns itself off when scrolled up; Clear empties the view only. A new run (a restart) is read from its start below a
 * divider. The input line writes to the process's stdin.
 */
@Component({
  selector: 'q-runner-output',
  imports: [Button, Icon, Input],
  template: `
    <div class="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0 text-xs">
      <div class="relative w-64 shrink-0">
        <svg [qIcon]="icons.Search" class="size-3.5 text-muted absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"></svg>
        <input qInput class="h-7 text-xs pl-7" placeholder="Search the output" aria-label="Search the output" [value]="search()" (input)="typedSearch($event)" (keydown.escape)="search.set('')" data-testid="runner-output-search" />
      </div>
      @if (needle()) {
        <span class="text-muted whitespace-nowrap" data-testid="runner-output-matches">{{ shown().length }} of {{ lines().length }} lines</span>
      }
      <span class="flex-1"></span>
      <button qButton size="sm" [variant]="follow() ? 'secondary' : 'ghost'" [icon]="icons.ArrowDownToLine" [attr.aria-pressed]="follow()" data-testid="runner-output-follow" (click)="toggleFollow()">Follow</button>
      <button qButton size="sm" variant="ghost" [icon]="icons.Eraser" [disabled]="!lines().length" data-testid="runner-output-clear" (click)="clear()">Clear</button>
    </div>
    @if (dropped()) {
      <p class="flex items-center gap-2 px-3 py-1.5 text-[11px] text-warning border-b border-edge shrink-0" data-testid="runner-output-dropped">
        <svg [qIcon]="icons.TriangleAlert" class="size-3.5 shrink-0"></svg> {{ dropped() }} lines went by before they could be read: the runner keeps the last 5000 lines of a run.
      </p>
    }
    <div #list class="flex-1 min-h-0 overflow-auto bg-canvas font-mono text-xs leading-[1.45] py-1" data-testid="runner-output" (scroll)="scrolled()">
      @for (l of shown(); track l.key) {
        @if (l.stream === 'divider') {
          <div class="flex items-center gap-2 px-3 py-1 text-[10px] text-muted uppercase tracking-wide select-none"><span class="h-px flex-1 bg-edge"></span>{{ l.plain }}<span class="h-px flex-1 bg-edge"></span></div>
        } @else {
          <div class="px-3 whitespace-pre-wrap break-all hover:bg-surface" [class.text-danger]="l.stream === 'stderr'" [class.text-muted]="l.stream === 'system'" [class.italic]="l.stream === 'system'" [attr.data-stream]="l.stream" [attr.title]="l.at" data-testid="runner-output-line">@for (s of l.spans; track $index) {<span [style]="s.css">{{ s.text }}</span>}</div>
        }
      }
      @if (!lines().length) {
        <p class="px-3 py-2 text-muted font-sans" data-testid="runner-output-empty">{{ empty() }}</p>
      } @else if (!shown().length) {
        <p class="px-3 py-2 text-muted font-sans">No line matches the search.</p>
      }
    </div>
    <form class="flex items-center gap-2 px-3 h-10 border-t border-edge shrink-0" (submit)="send($event)">
      <span class="font-mono text-xs text-muted select-none">stdin</span>
      <input qInput class="h-7 text-xs font-mono flex-1" [placeholder]="live() ? 'Type a line and press Enter' : 'The task is not running'" aria-label="Send a line to the process" [disabled]="!live()" [value]="stdin()" (input)="typedStdin($event)" data-testid="runner-stdin" />
      <button qButton size="sm" variant="ghost" type="submit" [icon]="icons.CornerDownLeft" [disabled]="!live() || sending()" data-testid="runner-stdin-send">Send</button>
    </form>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'runner-output-pane' },
})
export class RunnerOutput {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly taskId = input.required<string>();
  /** Whether the task has a process to write to. */
  readonly live = input(false);

  protected readonly icons = { ArrowDownToLine, CornerDownLeft, Eraser, Search, TriangleAlert };
  protected readonly lines = signal<ShownLine[]>([]);
  protected readonly dropped = signal(0);
  protected readonly follow = signal(true);
  protected readonly search = signal('');
  protected readonly stdin = signal('');
  protected readonly sending = signal(false);
  /** Before the first read, the task has not run (NOT_FOUND), read, or why reading failed. */
  private readonly readState = signal<'loading' | 'none' | 'read' | string>('loading');
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  protected readonly needle = computed(() => this.search().trim().toLowerCase());
  protected readonly shown = computed(() => {
    const n = this.needle();
    return n ? this.lines().filter((l) => l.stream !== 'divider' && l.plain.includes(n)) : this.lines();
  });
  protected readonly empty = computed(() => {
    const s = this.readState();
    if (s === 'loading') return 'Reading…';
    if (s === 'none') return 'Not started yet. Start the task to see its output here.';
    if (s === 'read') return this.live() ? 'Nothing printed yet.' : 'No output on screen.';
    return s;
  });

  private runId: string | null = null;
  private next = 0;
  /** The colour state the last line of the run ended with. */
  private style: AnsiStyle = {};
  private reading = false;
  private again = false;
  /** Where the view last scrolled itself to, so the scroll event that follows does not count as the user's. */
  private autoTop: number | null = null;

  constructor() {
    // Another task in the same tab component (the shell reuses it) starts from nothing.
    effect(() => {
      this.taskId();
      untracked(() => {
        this.lines.set([]);
        this.dropped.set(0);
        this.readState.set('loading');
        this.runId = null;
        this.next = 0;
        this.style = {};
        void this.read();
      });
    });
    injectRunnerChanged((p) => {
      if (p.taskId === untracked(this.taskId) && p.reason !== 'tasks') void this.read();
    });
    afterRenderEffect(() => {
      this.shown();
      if (this.follow()) this.toBottom();
    });
    // A hidden pane (the Settings view, another tab) cannot scroll; once it is shown again, follow catches up.
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(() => {
        if (untracked(this.follow)) this.toBottom();
      });
      observer.observe(this.list().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  private toBottom(): void {
    const el = this.list().nativeElement;
    if (!el.clientHeight || el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return;
    el.scrollTop = el.scrollHeight;
    this.autoTop = el.scrollTop;
  }

  private toShown(runId: string, l: RunnerOutputLine): ShownLine {
    const { spans, style } = parseAnsi(l.text, this.style);
    this.style = style;
    return { key: `${runId}:${l.seq}`, stream: l.stream, spans, plain: plainText(l.text).toLowerCase(), at: l.at };
  }

  /** One read at a time; an event that arrives during one makes it read once more. */
  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        const taskId = this.taskId();
        for (let page = 0; page < PAGES; page++) {
          let chunk = await this.host.invoke<RunnerOutputChunk>('runner.proc.output', { taskId, after: this.next, limit: PAGE });
          if (taskId !== this.taskId()) return;
          if (chunk.runId !== this.runId) {
            // A new run: its lines are read from its first, below a divider when an older run is on screen.
            if (this.next !== 0) chunk = await this.host.invoke<RunnerOutputChunk>('runner.proc.output', { taskId, after: 0, limit: PAGE });
            if (taskId !== this.taskId()) return;
            if (this.runId !== null && this.lines().length) {
              const divider: ShownLine = { key: `${chunk.runId}:start`, stream: 'divider', spans: [], plain: 'new run', at: '' };
              this.lines.update((ls) => [...ls, divider]);
            }
            this.runId = chunk.runId;
            this.style = {};
          }
          this.next = chunk.next;
          const runId = chunk.runId;
          if (chunk.dropped) this.dropped.update((d) => d + chunk.dropped);
          if (chunk.lines.length) {
            const added = chunk.lines.map((l) => this.toShown(runId, l));
            this.lines.update((ls) => (ls.length + added.length > KEEP ? [...ls, ...added].slice(-KEEP) : [...ls, ...added]));
          }
          this.readState.set('read');
          if (chunk.lines.length < PAGE) break;
        }
      } while (this.again);
    } catch (err) {
      const e = toErrorPayload(err);
      this.readState.set(e.code === 'NOT_FOUND' ? 'none' : `Reading the output failed: ${e.message}`);
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        void this.read();
      }
    }
  }

  protected scrolled(): void {
    const el = this.list().nativeElement;
    if (this.autoTop !== null && el.scrollTop === this.autoTop) return;
    this.autoTop = null;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    if (atBottom !== this.follow()) this.follow.set(atBottom);
  }

  protected toggleFollow(): void {
    this.follow.update((f) => !f);
  }

  protected clear(): void {
    this.lines.set([]);
    this.dropped.set(0);
  }

  protected typedSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected typedStdin(event: Event): void {
    this.stdin.set((event.target as HTMLInputElement).value);
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.live() || this.sending()) return;
    this.sending.set(true);
    try {
      await this.host.invoke('runner.proc.input', { taskId: this.taskId(), text: `${this.stdin()}\n` });
      this.stdin.set('');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.sending.set(false);
    }
  }
}
