import { Directive } from '@angular/core';

@Directive({
  selector: 'span[qBadge]',
  host: { class: 'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-elevated text-muted' },
})
export class Badge {}
