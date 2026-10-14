import { Component, computed, input } from '@angular/core';
import type { LogsHits } from '@quiver/core';

/** How many entries fell in each step of the range, as a strip of bars with the total beside it. */
@Component({
  selector: 'q-logs-histogram',
  template: `
    @let h = hits();
    <div class="flex items-end gap-px h-10 flex-1 min-w-0" role="img" [attr.aria-label]="label()">
      @for (b of bars(); track b.time) {
        <div class="flex-1 min-w-px rounded-t-sm bg-accent/60 hover:bg-accent" [style.height.%]="b.height" [title]="b.title"></div>
      }
    </div>
    <div class="shrink-0 w-28 text-right text-[11px] text-muted leading-tight" data-testid="logs-hits-total">
      @if (h) {
        <div class="text-fg font-medium">{{ h.total.toLocaleString() }}</div>
        <div>matches · {{ step() }} bars</div>
      }
    </div>
  `,
  host: { class: 'flex items-end gap-3 px-3 py-1.5 border-b border-edge shrink-0', 'data-testid': 'logs-histogram' },
})
export class LogsHistogram {
  readonly hits = input<LogsHits | null>(null);

  protected readonly bars = computed(() => {
    const h = this.hits();
    if (!h) return [];
    // Fill empty steps, so the strip spans the whole range evenly.
    const from = Date.parse(h.from);
    const to = Date.parse(h.to);
    const counts = new Map(h.buckets.map((b) => [b.time, b.count]));
    const start = Math.floor(from / h.stepMs) * h.stepMs;
    const times: number[] = [];
    for (let t = start; t < to && times.length < 500; t += h.stepMs) times.push(t);
    for (const b of h.buckets) if (!times.includes(b.time)) times.push(b.time);
    times.sort((a, b) => a - b);
    const max = Math.max(1, ...times.map((t) => counts.get(t) ?? 0));
    return times.map((time) => {
      const count = counts.get(time) ?? 0;
      return { time, height: count ? Math.max(4, (count / max) * 100) : 0, title: `${new Date(time).toLocaleString()}: ${count.toLocaleString()}` };
    });
  });
  protected readonly step = computed(() => {
    const ms = this.hits()?.stepMs ?? 0;
    if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
    if (ms % 60_000 === 0) return `${ms / 60_000}m`;
    return `${ms / 1000}s`;
  });
  protected readonly label = computed(() => `${this.hits()?.total ?? 0} matching entries over time`);
}
