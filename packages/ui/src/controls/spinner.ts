import { Directive, ElementRef, Renderer2, afterNextRender, inject } from '@angular/core';
import { LoaderCircle } from 'lucide';
import { drawIcon } from '../icon/icon';

/** The spinning loader: `<svg qSpinner></svg>`, sized with classes like any icon. */
@Directive({
  selector: 'svg[qSpinner]',
  host: {
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    class: 'size-4 animate-spin text-muted',
  },
})
export class Spinner {
  constructor() {
    const svg = inject<ElementRef<SVGElement>>(ElementRef).nativeElement;
    const renderer = inject(Renderer2);
    afterNextRender({ write: () => drawIcon(renderer, svg, LoaderCircle) });
  }
}
