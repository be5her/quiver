import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { toErrorPayload, type DbQueryResult, type ErrorPayload, type MetabaseCard, type MetabaseDatabase, type MetabaseParameter, type MetabaseParameterValue } from '@quiver/core';
import { Button, HostBridge, Icon, Input, Label, Spinner, TabsState, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { FileChartColumn, Play } from 'lucide';
import type { MetabaseExportSource } from './export-menu';
import { MetabaseError } from './metabase-error';
import { parameterDefault, parameterInputType, parameterValue } from './metabase-format';
import { MetabaseResult } from './metabase-result';

/**
 * A saved question: its parameters as a small form, run on Metabase, the rows in the grid. It runs
 * once when the tab opens; the parameter values stay with the tab.
 */
@Component({
  selector: 'q-mb-question-tab',
  imports: [Button, Icon, Input, Label, MetabaseError, MetabaseResult, Spinner],
  template: `
    @if (card.error(); as error) {
      <q-mb-error [error]="error" [connectionId]="connectionId()" (retry)="card.reload()" />
    } @else if (card.value(); as c) {
      <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
        <svg [qIcon]="icons.FileChartColumn" class="size-4 text-accent shrink-0"></svg>
        <span class="font-medium text-sm truncate max-w-80" [title]="c.description ?? c.name">{{ c.name }}</span>
        @if (databaseName(); as name) {
          <span class="text-xs text-muted truncate" data-testid="mb-question-database">{{ name }}</span>
        }
        <span class="flex-1"></span>
        <button qButton variant="primary" size="sm" [icon]="icons.Play" [loading]="running()" data-testid="mb-run" (click)="run()">Run</button>
      </div>
      @if (c.parameters.length) {
        <div class="flex items-end gap-3 px-3 py-2 border-b border-edge shrink-0 flex-wrap" data-testid="mb-params">
          @for (p of c.parameters; track p.id) {
            <div class="w-48">
              <label qLabel [for]="'mb-param-' + p.slug">{{ p.name }}</label>
              <input
                qInput
                class="h-7"
                [id]="'mb-param-' + p.slug"
                [type]="inputType(p)"
                [value]="values()[p.slug] ?? ''"
                [attr.data-testid]="'mb-param-' + p.slug"
                [attr.data-type]="p.type"
                (input)="setValue(p, $event)"
                (keydown.enter)="run()"
              />
            </div>
          }
          <p class="text-[11px] text-muted pb-1.5">Empty parameters are left out. Enter runs.</p>
        </div>
      }
      <q-mb-result [connectionId]="connectionId()" [result]="result()" [error]="error()" [running]="running()" [exportName]="c.name" [exportSource]="exportSource()" (retry)="run()" />
    } @else {
      <div class="flex items-center justify-center h-full w-full"><svg qSpinner></svg></div>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class MetabaseQuestionTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { FileChartColumn, Play };
  protected readonly connectionId = computed(() => String(this.tab().data?.['connectionId'] ?? ''));
  private readonly cardId = computed(() => Number(this.tab().data?.['cardId']));
  protected readonly card = invokeResource<MetabaseCard>('metabase.card.get', () => ({ connectionId: this.connectionId(), cardId: this.cardId() }));
  private readonly databases = invokeResource<MetabaseDatabase[]>('metabase.databases', () => ({ connectionId: this.connectionId() }), { enabled: () => this.card.value()?.databaseId != null });
  protected readonly databaseName = computed(() => {
    const id = this.card.value()?.databaseId;
    return id == null ? null : (this.databases.value()?.find((d) => d.id === id)?.name ?? null);
  });
  /** The text typed per parameter slug, restored from the tab. */
  protected readonly values = linkedSignal<string, Record<string, string>>({
    source: () => this.tab().id,
    computation: () => untracked(() => ({ ...((this.tab().data?.['state'] as { parameters?: Record<string, string> } | undefined)?.parameters ?? {}) })),
  });
  protected readonly running = signal(false);
  protected readonly result = signal<DbQueryResult | null>(null);
  protected readonly error = signal<ErrorPayload | null>(null);
  /** The parameters of the last run, which "Save all rows" sends again. */
  private readonly ranWith = signal<MetabaseParameterValue[] | null>(null);
  protected readonly exportSource = computed<MetabaseExportSource | null>(() => {
    const parameters = this.ranWith();
    return parameters ? { cardId: this.cardId(), parameters } : null;
  });

  constructor() {
    // Parameters not typed yet start at the question's defaults, and the question runs once.
    let ran = false;
    effect(() => {
      const c = this.card.value();
      if (!c || ran) return;
      ran = true;
      untracked(() => {
        const current = this.values();
        const filled = { ...current };
        for (const p of c.parameters) if (!(p.slug in filled)) filled[p.slug] = parameterDefault(p);
        this.values.set(filled);
        void this.run();
      });
    });

    effect(() => {
      const name = this.card.value()?.name;
      const tab = this.tab();
      if (name && tab.title !== name) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { title: name }));
    });
  }

  protected inputType(p: MetabaseParameter): string {
    return parameterInputType(p);
  }

  protected setValue(p: MetabaseParameter, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.values.update((v) => ({ ...v, [p.slug]: text }));
  }

  protected async run(): Promise<void> {
    const c = this.card.value();
    if (!c || this.running()) return;
    const values = this.values();
    const parameters: MetabaseParameterValue[] = c.parameters.filter((p) => (values[p.slug] ?? '').trim() !== '').map((p) => ({ id: p.id, value: parameterValue(p, values[p.slug].trim()) }));
    this.persist();
    this.running.set(true);
    this.error.set(null);
    try {
      this.result.set(await this.host.invoke<DbQueryResult>('metabase.card.run', { connectionId: this.connectionId(), cardId: c.id, parameters }));
      this.ranWith.set(parameters);
    } catch (err) {
      this.error.set(toErrorPayload(err));
    } finally {
      this.running.set(false);
    }
  }

  private persist(): void {
    const tab = this.tab();
    const state = { parameters: this.values() };
    if (JSON.stringify(tab.data?.['state']) !== JSON.stringify(state)) this.tabs.updateTab(this.scope(), tab.id, { data: { ...tab.data, state } });
  }
}
