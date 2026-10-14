import { Component, booleanAttribute, computed, input } from '@angular/core';
import { cn } from '@quiver/ui';

/**
 * A sidebar row: `<div qApiRow [label]="name" (click)="open()">`. An element marked `rowPrefix` goes
 * before the label; other content is the actions shown on hover.
 */
@Component({
  selector: 'div[qApiRow]',
  template: `<ng-content select="[rowPrefix]" /><span class="truncate flex-1 text-[13px]" [class.font-medium]="bold()">{{ label() }}</span><span class="hidden group-hover:flex items-center"><ng-content /></span>`,
  host: {
    role: 'button',
    tabindex: '0',
    '[class]': 'classes()',
    '[style.padding-left.px]': '8 + depth() * 14',
  },
})
export class ApiRow {
  readonly label = input.required<string>();
  readonly depth = input(0);
  readonly bold = input(false, { transform: booleanAttribute });
  readonly active = input(false, { transform: booleanAttribute });

  protected readonly classes = computed(() => cn('group flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0', this.active() && 'bg-elevated'));
}
