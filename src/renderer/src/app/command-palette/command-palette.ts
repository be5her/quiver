import { Component, ElementRef, afterRenderEffect, computed, effect, inject, linkedSignal, untracked, viewChild } from '@angular/core';
import { commandScore } from '@quiver/core';
import { AppState, Autofocus, HostBridge, Kbd, Toasts, UiActions } from '@quiver/ui';

interface PaletteItem {
  key: string;
  /** What the search matches against. */
  value: string;
  title: string;
  shortcut?: string;
  /** Shown on the right for host commands. */
  commandId?: string;
  run(): void;
}

interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}

/**
 * Ctrl+K: every UI action that applies, plus the host commands that run without input. Typing
 * filters and ranks them fuzzily; arrows (or Ctrl+N/P, Ctrl+J/K) move, Enter runs, Escape closes.
 */
@Component({
  selector: 'q-command-palette',
  imports: [Autofocus, Kbd],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.css',
  host: { class: 'contents' },
})
export class CommandPalette {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly actions = inject(UiActions);
  private readonly list = viewChild<ElementRef<HTMLDivElement>>('list');

  protected readonly open = this.app.paletteOpen;
  /** Starts empty every time the palette opens. */
  protected readonly search = linkedSignal({ source: this.open, computation: () => '' });

  /** The entries, grouped, in their own order. Re-read on opening, since `when` depends on the moment. */
  private readonly groups = computed<PaletteGroup[]>(() => {
    if (!this.open()) return [];
    const actions = this.actions.actions();
    const visible = actions.filter((a) => !a.when || a.when());
    const byGroup = new Map<string, PaletteItem[]>();
    for (const a of visible) {
      const item: PaletteItem = {
        key: `action:${a.id}`,
        value: `${a.title} ${a.keywords?.join(' ') ?? ''} ${a.description ?? ''}`.trim(),
        title: a.title,
        shortcut: a.shortcut,
        run: () => void a.run(),
      };
      byGroup.set(a.group, [...(byGroup.get(a.group) ?? []), item]);
    }
    const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([heading, items]) => ({ heading, items }));
    // A UI action with the same id as a host command wraps it with proper feedback, so the raw command steps aside.
    const hasWorkspace = this.app.hasWorkspace();
    const runnable = this.app.commands().filter((c) => !c.hidden && c.noInput && (c.scope === 'global' || hasWorkspace) && !actions.some((a) => a.id === c.id));
    if (runnable.length) {
      groups.push({
        heading: 'Host commands',
        items: runnable.map((c) => ({
          key: `command:${c.id}`,
          value: `${c.title} ${c.id} ${c.description}`.trim(),
          title: c.title,
          commandId: c.id,
          run: () => void this.runHostCommand(c.id),
        })),
      });
    }
    return groups;
  });

  /** What the search leaves: matches ranked by score within their group, groups by their best match. */
  protected readonly shown = computed<PaletteGroup[]>(() => {
    const search = this.search();
    if (!search) return this.groups();
    return this.groups()
      .map((group) => {
        const scored = group.items.map((item) => ({ item, score: commandScore(item.value, search) })).filter((s) => s.score > 0);
        scored.sort((a, b) => b.score - a.score);
        return { group: { heading: group.heading, items: scored.map((s) => s.item) }, best: scored[0]?.score ?? 0 };
      })
      .filter((g) => g.group.items.length > 0)
      .sort((a, b) => b.best - a.best)
      .map((g) => g.group);
  });

  private readonly flat = computed(() => this.shown().flatMap((g) => g.items));

  /** The highlighted entry: the first match after every keystroke, then wherever the keys or the pointer take it. */
  protected readonly selected = linkedSignal<{ search: string; keys: string[] }, string | undefined>({
    source: () => ({ search: this.search(), keys: this.flat().map((i) => i.key) }),
    computation: (source, previous) =>
      previous && previous.source.search === source.search && previous.value && source.keys.includes(previous.value) ? previous.value : source.keys[0],
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onKey = (e: KeyboardEvent) => e.key === 'Escape' && this.close();
      window.addEventListener('keydown', onKey);
      onCleanup(() => window.removeEventListener('keydown', onKey));
    });

    // Keep the highlighted entry in view, with its group's heading when it is the first of the group.
    afterRenderEffect({
      write: () => {
        const key = this.selected();
        const item = key ? this.list()?.nativeElement.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
        if (!item) return;
        if (item.parentElement?.firstElementChild === item) item.closest('[data-group]')?.querySelector('[data-heading]')?.scrollIntoView({ block: 'nearest' });
        item.scrollIntoView({ block: 'nearest' });
      },
    });
  }

  protected close(): void {
    this.open.set(false);
  }

  protected typed(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  protected choose(item: PaletteItem): void {
    this.close();
    item.run();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const vim = event.ctrlKey;
    switch (event.key) {
      case 'n':
      case 'j':
        if (vim) this.next(event);
        break;
      case 'ArrowDown':
        this.next(event);
        break;
      case 'p':
      case 'k':
        if (vim) this.previous(event);
        break;
      case 'ArrowUp':
        this.previous(event);
        break;
      case 'Home':
        event.preventDefault();
        this.selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        this.selectAt(untracked(this.flat).length - 1);
        break;
      case 'Enter': {
        event.preventDefault();
        const key = untracked(this.selected);
        const item = untracked(this.flat).find((i) => i.key === key);
        if (item) this.choose(item);
      }
    }
  }

  private next(event: KeyboardEvent): void {
    event.preventDefault();
    if (event.metaKey) this.selectAt(untracked(this.flat).length - 1);
    else if (event.altKey) this.jumpGroup(1);
    else this.step(1);
  }

  private previous(event: KeyboardEvent): void {
    event.preventDefault();
    if (event.metaKey) this.selectAt(0);
    else if (event.altKey) this.jumpGroup(-1);
    else this.step(-1);
  }

  /** One entry up or down, wrapping around at either end. */
  private step(by: 1 | -1): void {
    const items = untracked(this.flat);
    if (!items.length) return;
    const index = items.findIndex((i) => i.key === untracked(this.selected));
    this.selected.set(items[(index + by + items.length) % items.length].key);
  }

  /** The first entry of the next or previous group; past the last group, a plain step. */
  private jumpGroup(by: 1 | -1): void {
    const groups = untracked(this.shown);
    const at = groups.findIndex((g) => g.items.some((i) => i.key === untracked(this.selected)));
    const target = groups[at + by];
    if (target?.items.length) this.selected.set(target.items[0].key);
    else this.step(by);
  }

  private selectAt(index: number): void {
    const item = untracked(this.flat)[index];
    if (item) this.selected.set(item.key);
  }

  private async runHostCommand(id: string): Promise<void> {
    try {
      const result = await this.host.invoke(id, {});
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      this.toasts.notify(`${id}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
