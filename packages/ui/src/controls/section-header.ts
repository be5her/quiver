import { Component, input } from '@angular/core';

/**
 * The small caps header of a sidebar section. `title` is plain text; an element marked `sectionTitle`
 * replaces it (e.g. a toggle). Other projected content is the actions on the right.
 */
@Component({
  selector: 'q-section-header',
  template: `<span>{{ title() }}<ng-content select="[sectionTitle]" /></span><div class="flex items-center gap-0.5"><ng-content /></div>`,
  host: { class: 'flex items-center justify-between px-3 h-7 text-[11px] font-semibold uppercase tracking-wide text-muted' },
})
export class SectionHeader {
  readonly title = input('');
}
