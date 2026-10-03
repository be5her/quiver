import { Component, input } from '@angular/core';

/** A centred title and hint for a view with nothing to show. Projected content is the call to action. */
@Component({
  selector: 'q-empty-state',
  template: `<p class="text-sm font-medium text-fg">{{ title() }}</p>@if (hint()) {<p class="text-xs text-muted max-w-xs">{{ hint() }}</p>}<div class="mt-2 empty:hidden"><ng-content /></div>`,
  host: { class: 'flex flex-col items-center justify-center gap-2 p-8 text-center h-full' },
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly hint = input<string | null>();
}
