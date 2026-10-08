import { Component, DestroyRef, Directive, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { sortTodos, type TodoItem } from '@quiver/core';
import { Button, Checkbox, Icon, IconButton, Input, SectionHeader, Spinner, cn, invokeResource } from '@quiver/ui';
import { ChevronDown, Trash2, X } from 'lucide';
import { TodoActions } from './todo-actions';

/** The tick of a todo; it sits on the first line of the title, however many lines that wraps to. */
@Directive({
  selector: 'input[qTodoTick]',
  host: {
    type: 'checkbox',
    class: 'mt-[3px] shrink-0',
    'data-testid': 'todo-toggle',
    '[checked]': 'qTodoTick().done',
    '[attr.aria-label]': "'Done: ' + qTodoTick().title",
    '(change)': 'toggle($event)',
  },
})
export class TodoTick {
  private readonly todos = inject(TodoActions);

  readonly qTodoTick = input.required<TodoItem>();

  protected toggle(event: Event): void {
    void this.todos.run('todo.update', { id: this.qTodoTick().id, done: (event.target as HTMLInputElement).checked });
  }
}

/** A todo at rest: the title wraps instead of being cut at the panel's edge, with the start of its notes underneath. Click to open it. */
@Component({
  selector: 'q-todo-line',
  imports: [Checkbox, Icon, IconButton, TodoTick],
  template: `
    @let t = item();
    <input qCheckbox [qTodoTick]="t" />
    <button type="button" class="flex-1 min-w-0 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50" data-testid="todo-title" (click)="opened.emit()">
      <span class="text-[13px] leading-5 wrap-anywhere line-clamp-3" [class.line-through]="t.done">{{ t.title }}</span>
      @if (notes()) {
        <span class="mt-0.5 text-xs leading-[1.125rem] text-muted wrap-anywhere line-clamp-2" data-testid="todo-notes-preview">{{ notes() }}</span>
      }
    </button>
    <button qIconButton label="Remove" size="sm" class="shrink-0 -mt-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" data-testid="todo-remove" (click)="todos.run('todo.remove', { id: t.id })">
      <svg [qIcon]="remove" class="size-3.5"></svg>
    </button>
  `,
  host: { class: 'flex items-start gap-2 pl-3 pr-1.5 py-1.5' },
})
export class TodoLine {
  protected readonly todos = inject(TodoActions);

  readonly item = input.required<TodoItem>();
  readonly opened = output<void>();

  protected readonly remove = X;
  protected readonly notes = computed(() => this.item().notes.trim());
}

// Fields as tall as their text, so a long title or long notes are read without scrolling inside a small box.
const FIELD = 'field-sizing-content resize-none rounded-md border bg-transparent text-fg placeholder:text-muted/70 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30';

/** An open todo: the whole title and the notes, both editable in place, saved a moment after typing stops and when a field loses focus. */
@Component({
  selector: 'q-todo-editor',
  imports: [Button, Checkbox, Icon, IconButton, TodoTick],
  template: `
    @let t = item();
    <div class="flex items-start gap-2 pl-3 pr-1.5 pt-1.5">
      <input qCheckbox [qTodoTick]="t" />
      <!-- Padding and negative margin cancel out, so the text stays where it was in the closed row. -->
      <textarea
        [value]="title()"
        rows="1"
        spellcheck="false"
        [class]="titleClass()"
        aria-label="Title"
        data-testid="todo-edit-title"
        (input)="typedTitle($event)"
        (keydown.enter)="endTitle($event)"
        (focusout)="flush()"
      ></textarea>
      <button qIconButton label="Collapse" size="sm" class="shrink-0 -mt-0.5" data-testid="todo-collapse" (click)="collapse.emit()"><svg [qIcon]="icons.ChevronDown" class="size-3.5"></svg></button>
    </div>
    <div class="flex flex-col gap-1.5 px-3 pt-2 pb-2">
      <textarea
        [value]="notes()"
        placeholder="Notes"
        spellcheck="false"
        [class]="notesClass"
        aria-label="Notes"
        data-testid="todo-notes"
        (input)="typedNotes($event)"
        (focusout)="flush()"
      ></textarea>
      <div class="flex items-center gap-2 min-w-0">
        <p class="flex-1 min-w-0 truncate text-[11px] text-muted" data-testid="todo-dates">{{ dates() }}</p>
        <button qButton size="sm" variant="danger" [icon]="icons.X" data-testid="todo-remove" (click)="todos.run('todo.remove', { id: t.id })">Remove</button>
      </div>
    </div>
  `,
  host: { class: 'contents' },
})
export class TodoEditor {
  protected readonly todos = inject(TodoActions);

  readonly item = input.required<TodoItem>();
  readonly collapse = output<void>();

  protected readonly icons = { ChevronDown, X };
  protected readonly notesClass = cn(FIELD, 'w-full min-h-16 max-h-[50vh] px-2.5 py-1.5 border-edge text-[13px] leading-relaxed wrap-anywhere');
  /** What the fields hold: taken from the todo when the line opens, then the user's own. */
  protected readonly title = linkedSignal<TodoItem, string>({ source: this.item, computation: (item, previous) => previous?.value ?? item.title });
  protected readonly notes = linkedSignal<TodoItem, string>({ source: this.item, computation: (item, previous) => previous?.value ?? item.notes });
  protected readonly titleClass = computed(() =>
    cn(FIELD, 'flex-1 min-w-0 -mx-[7px] -my-[3px] px-1.5 py-0.5 border-transparent hover:border-edge text-[13px] leading-5 wrap-anywhere', this.item().done && 'line-through'),
  );
  protected readonly dates = computed(() => {
    const t = this.item();
    return t.completedAt ? `Done ${new Date(t.completedAt).toLocaleString()}` : `Added ${new Date(t.createdAt).toLocaleString()}`;
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { title: string; notes: string } | null = null;

  constructor() {
    // Save what is still pending when the line is collapsed or the panel goes away.
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  protected typedTitle(event: Event): void {
    // A title is one line of text, however many rows it wraps to.
    const next = (event.target as HTMLTextAreaElement).value.replace(/\s*\n\s*/g, ' ');
    this.title.set(next);
    this.schedule({ title: next, notes: this.notes() });
  }

  protected typedNotes(event: Event): void {
    const next = (event.target as HTMLTextAreaElement).value;
    this.notes.set(next);
    this.schedule({ title: this.title(), notes: next });
  }

  protected endTitle(event: Event): void {
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    (event.target as HTMLTextAreaElement).blur();
  }

  protected flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    const item = this.item();
    if (p && (p.title.trim() !== item.title || p.notes !== item.notes)) void this.todos.run('todo.update', { id: item.id, title: p.title, notes: p.notes });
  }

  private schedule(next: { title: string; notes: string }): void {
    this.pending = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 600);
  }
}

/** The day's list: type a line and press Enter, tick it off, open a line to read it in full and write notes, clear the done ones. */
@Component({
  selector: 'q-todo-sidebar',
  imports: [Icon, IconButton, Input, SectionHeader, Spinner, TodoEditor, TodoLine],
  template: `
    <q-section-header [title]="header()">
      <button qIconButton label="Clear completed" size="sm" [disabled]="done() === 0" data-testid="todo-clear" (click)="todos.run('todo.clear', {})"><svg [qIcon]="clear" class="size-3.5"></svg></button>
    </q-section-header>
    <div class="px-3 pb-2">
      <input qInput [value]="draft()" placeholder="Add a todo, then Enter" class="h-7" data-testid="todo-input" (input)="typed($event)" (keydown.enter)="add($event)" />
    </div>
    <div class="flex-1 min-h-0 overflow-y-auto" data-testid="todo-list">
      @if (list.isLoading() && !list.value()) {
        <div class="px-3 py-2"><svg qSpinner></svg></div>
      }
      @if (list.value()?.length === 0) {
        <p class="px-3 py-2 text-xs text-muted">Nothing yet. Add what you plan to do today; the list stays on this machine and is not committed.</p>
      }
      @for (item of items(); track item.id) {
        <div class="group border-b border-edge/60" [class.text-muted]="item.done" data-testid="todo-item" [attr.data-done]="item.done ? 'true' : null" [attr.data-title]="item.title">
          @if (open() === item.id) {
            <q-todo-editor [item]="item" (collapse)="open.set(null)" />
          } @else {
            <q-todo-line [item]="item" (opened)="open.set(item.id)" />
          }
        </div>
      }
      @if (list.error(); as error) {
        <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
      }
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0 text-sm' },
})
export class TodoSidebar {
  protected readonly todos = inject(TodoActions);

  protected readonly clear = Trash2;
  protected readonly list = invokeResource<TodoItem[]>('todo.list', () => ({}), { refreshOnEvents: ['todo.changed'] });
  protected readonly draft = signal('');
  protected readonly open = signal<string | null>(null);
  protected readonly items = computed(() => sortTodos(this.list.value() ?? []));
  protected readonly done = computed(() => this.items().filter((t) => t.done).length);
  protected readonly header = computed(() => (this.items().length ? `List · ${this.done()}/${this.items().length} done` : 'List'));

  protected typed(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected async add(event: Event): Promise<void> {
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    const title = this.draft().trim();
    if (!title) return;
    // Cleared on the element too: typed and sent within one task, the binding never saw the text, so '' would not count as a change.
    (event.target as HTMLInputElement).value = '';
    this.draft.set('');
    await this.todos.run('todo.add', { title });
  }
}
