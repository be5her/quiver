import { Directive } from '@angular/core';

@Directive({
  selector: 'kbd[qKbd]',
  host: { class: 'inline-flex items-center rounded border border-edge bg-elevated px-1.5 text-[10px] font-mono text-muted leading-4' },
})
export class Kbd {}
