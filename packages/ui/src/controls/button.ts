import { Component, booleanAttribute, computed, input } from '@angular/core';
import { LoaderCircle } from 'lucide';
import { cn } from '../class-names';
import { Icon, type IconNode } from '../icon/icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-fg hover:bg-elevated border-edge',
  ghost: 'bg-transparent text-fg hover:bg-elevated border-transparent',
  danger: 'bg-transparent text-danger hover:bg-danger/10 border-transparent',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs gap-1',
  md: 'h-8 px-3 text-sm gap-1.5',
};

/** `<button qButton variant="primary" [icon]="Save">Save</button>`. A spinner replaces the icon while `loading`, which also disables it. */
@Component({
  selector: 'button[qButton]',
  imports: [Icon],
  template: `@if (loading()) {<svg [qIcon]="spinner" class="size-3.5 animate-spin"></svg>} @else if (icon(); as icon) {<svg [qIcon]="icon" [class]="iconClass()"></svg>}<ng-content />`,
  host: {
    type: 'button',
    '[class]': 'classes()',
    '[disabled]': 'disabled() || loading()',
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('secondary');
  readonly size = input<ButtonSize>('md');
  readonly loading = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly icon = input<IconNode>();
  readonly iconClass = input('size-3.5');

  protected readonly spinner = LoaderCircle;
  protected readonly classes = computed(() =>
    cn(
      'inline-flex items-center justify-center rounded-md border font-medium transition-colors select-none',
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 disabled:pointer-events-none',
      VARIANT_CLASS[this.variant()],
      SIZE_CLASS[this.size()],
    ),
  );
}
