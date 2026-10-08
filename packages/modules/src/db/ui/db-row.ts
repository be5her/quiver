import { Component, booleanAttribute, input } from '@angular/core';

/**
 * A row of the Databases tree: `<div qDbRow [label]="name" (click)="open()">`. Elements marked
 * `rowPrefix` go before the label and `rowBadge` after it; other content is the actions shown on hover.
 */
@Component({
  selector: 'div[qDbRow]',
  template: `<ng-content select="[rowPrefix]" /><span class="truncate flex-1 text-[13px]" [class.font-medium]="bold()">{{ label() }}</span><ng-content select="[rowBadge]" />@if (hint()) {<span class="text-[10px] text-muted group-hover:hidden shrink-0">{{ hint() }}</span>}<span class="hidden group-hover:flex items-center"><ng-content /></span>`,
  host: {
    role: 'button',
    tabindex: '0',
    class: 'group flex items-center gap-1.5 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0',
    '[style.padding-left.px]': '8 + depth() * 14',
    '[attr.title]': 'label()',
  },
})
export class DbRow {
  readonly label = input.required<string>();
  readonly depth = input(0);
  readonly bold = input(false, { transform: booleanAttribute });
  readonly hint = input<string>();
}
