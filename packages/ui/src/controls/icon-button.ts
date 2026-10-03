import { Directive, computed, input } from '@angular/core';
import { cn } from '../class-names';
import type { ButtonSize } from './button';

/** A square button holding only an icon; `label` is its accessible name and tooltip. */
@Directive({
  selector: 'button[qIconButton]',
  host: {
    type: 'button',
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'label()',
    '[class]': 'classes()',
  },
})
export class IconButton {
  readonly label = input.required<string>();
  readonly size = input<ButtonSize>('md');

  protected readonly classes = computed(() =>
    cn(
      'inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-elevated transition-colors',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:pointer-events-none',
      this.size() === 'sm' ? 'size-6' : 'size-7',
    ),
  );
}
