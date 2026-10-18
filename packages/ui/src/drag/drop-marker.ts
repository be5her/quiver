import { Component, computed, input } from '@angular/core';
import type { DragAxis } from './drag-reorder';

/** The accent line showing where a dragged item will land. Its container must be `relative`. */
@Component({
  selector: 'q-drop-marker',
  template: '',
  host: {
    '[class]': 'classes()',
    '[style.left.px]': 'axis() === "x" ? at() : null',
    '[style.top.px]': 'axis() === "y" ? at() : null',
    '[attr.data-testid]': 'testId()',
  },
})
export class DropMarker {
  readonly axis = input.required<DragAxis>();
  readonly at = input.required<number>();
  readonly testId = input<string>();

  protected readonly classes = computed(() =>
    this.axis() === 'x'
      ? 'block absolute top-1 bottom-1 w-0.5 -ml-px rounded-full bg-accent pointer-events-none z-10'
      : 'block absolute left-1.5 right-1.5 h-0.5 -mt-px rounded-full bg-accent pointer-events-none z-10',
  );
}
