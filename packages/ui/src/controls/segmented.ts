import { Component, Directive, computed, inject, input, model } from '@angular/core';
import { cn } from '../class-names';

/**
 * A row of tabs that picks one value: `<q-segmented [(value)]="view"><button qSegment="body">Body</button>…</q-segmented>`.
 * The parent renders the matching content.
 */
@Component({
  selector: 'q-segmented',
  template: '<ng-content />',
  host: { role: 'tablist', class: 'flex items-center gap-0.5 border-b border-edge' },
})
export class Segmented<T extends string = string> {
  readonly value = model.required<T>();
}

@Directive({
  selector: 'button[qSegment]',
  host: {
    type: 'button',
    role: 'tab',
    '[attr.aria-selected]': 'selected()',
    '[class]': 'classes()',
    '(click)': 'choose()',
  },
})
export class Segment {
  private readonly group = inject(Segmented);

  readonly qSegment = input.required<string>();

  protected readonly selected = computed(() => this.group.value() === this.qSegment());
  protected readonly classes = computed(() =>
    cn('px-3 h-8 text-xs font-medium border-b-2 -mb-px transition-colors', this.selected() ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'),
  );

  protected choose(): void {
    this.group.value.set(this.qSegment());
  }
}
