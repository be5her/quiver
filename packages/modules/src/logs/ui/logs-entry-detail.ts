import { Component, computed, inject, input, output } from '@angular/core';
import type { LogEntry, LogsFilter } from '@quiver/core';
import { Button, CodeEditor, Icon, IconButton, Toasts } from '@quiver/ui';
import { Copy, Minus, Plus, X } from 'lucide';
import { clockTime, formatMessage, levelText } from './logs-format';

/** One entry in full: when, level, the message (indented when it is JSON) and every field, each one click from a filter. */
@Component({
  selector: 'q-logs-entry-detail',
  imports: [Button, CodeEditor, Icon, IconButton],
  template: `
    @let e = entry();
    <div class="flex items-center gap-2 px-3 h-9 border-b border-edge text-[11px] text-muted shrink-0">
      @if (e.level) {
        <span class="font-semibold" [class]="levelClass()">{{ e.level }}</span>
      }
      <span class="font-mono" [title]="e.ns + ' ns'">{{ at() }}</span>
      <span class="flex-1"></span>
      <button qButton size="sm" variant="ghost" [icon]="icons.Copy" (click)="copyEntry()">Copy</button>
      <button qIconButton label="Close" size="sm" (click)="closed.emit()"><svg [qIcon]="icons.X" class="size-3.5"></svg></button>
    </div>
    <div class="shrink-0 p-2 border-b border-edge" [style.height.px]="messageHeight()">
      <q-code-editor [value]="message().text" readonly [language]="message().language" [wrap]="true" />
    </div>
    <div class="flex-1 min-h-0 overflow-y-auto" data-testid="logs-entry-fields">
      <table class="w-full text-xs">
        <tbody>
          @for (f of fields(); track f.key) {
            <tr class="group border-b border-edge/60 align-top" data-testid="logs-entry-field" [attr.data-field]="f.key">
              <td class="pl-3 pr-2 py-1 font-mono text-muted whitespace-nowrap w-0">{{ f.key }}</td>
              <td class="pr-1 py-1 font-mono break-all">{{ f.value }}</td>
              <td class="pr-2 py-0.5 w-0 whitespace-nowrap">
                <span class="flex opacity-0 group-hover:opacity-100">
                  <button qIconButton size="sm" [label]="'Keep only ' + f.key + ' = ' + f.value" data-testid="logs-filter-for" (click)="filter.emit({ field: f.key, value: f.value, exclude: false })"><svg [qIcon]="icons.Plus" class="size-3"></svg></button>
                  <button qIconButton size="sm" [label]="'Leave out ' + f.key + ' = ' + f.value" data-testid="logs-filter-out" (click)="filter.emit({ field: f.key, value: f.value, exclude: true })"><svg [qIcon]="icons.Minus" class="size-3"></svg></button>
                </span>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'logs-entry-detail' },
})
export class LogsEntryDetail {
  private readonly toasts = inject(Toasts);

  readonly entry = input.required<LogEntry>();
  readonly filter = output<LogsFilter>();
  readonly closed = output<void>();

  protected readonly icons = { Copy, Minus, Plus, X };
  protected readonly message = computed(() => formatMessage(this.entry().msg));
  /** Short messages take little room, so the fields stay in view. */
  protected readonly messageHeight = computed(() => {
    const lines = this.message().text.split('\n').length + Math.floor(this.message().text.length / 80);
    return Math.min(320, Math.max(64, lines * 18 + 20));
  });
  protected readonly fields = computed(() =>
    Object.entries(this.entry().fields)
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
  protected readonly levelClass = computed(() => levelText(this.entry().level));
  protected readonly at = computed(() => `${new Date(this.entry().time).toLocaleDateString()} ${clockTime(this.entry().time)}`);

  protected copyEntry(): void {
    const e = this.entry();
    this.toasts.copy(JSON.stringify({ _time: e.time, _msg: e.msg, ...e.fields }, null, 2), 'Entry copied');
  }
}
