import { Directive, ElementRef, Renderer2, afterRenderEffect, inject, input, numberAttribute } from '@angular/core';
import type { IconNode } from 'lucide';

export type { IconNode };

/** Replace the children of `svg` with the shapes of a lucide icon. */
export function drawIcon(renderer: Renderer2, svg: SVGElement, icon: IconNode): void {
  for (const child of Array.from(svg.childNodes)) renderer.removeChild(svg, child);
  for (const [tag, attrs] of icon) {
    const shape = renderer.createElement(tag, 'svg') as SVGElement;
    for (const [name, value] of Object.entries(attrs)) {
      if (value !== undefined) renderer.setAttribute(shape, name, String(value));
    }
    renderer.appendChild(svg, shape);
  }
}

/**
 * Draws a lucide icon into the `<svg>` it sits on: `<svg [qIcon]="Check" class="size-3.5"></svg>`.
 * The attributes match what lucide renders anywhere else, so icons size and colour with Tailwind classes.
 */
@Directive({
  selector: 'svg[qIcon]',
  host: {
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    '[attr.stroke-width]': 'strokeWidth()',
  },
})
export class Icon {
  readonly qIcon = input.required<IconNode>();
  readonly strokeWidth = input(2, { transform: numberAttribute });

  constructor() {
    const svg = inject<ElementRef<SVGElement>>(ElementRef).nativeElement;
    const renderer = inject(Renderer2);
    afterRenderEffect({ write: () => drawIcon(renderer, svg, this.qIcon()) });
  }
}
