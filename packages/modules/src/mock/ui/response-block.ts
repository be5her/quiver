import { Component, input } from '@angular/core';
import { HeaderTable } from '../../api/ui';
import { MockBodyPane } from './body-pane';
import type { FormattedBody } from './mock-format';

/** One answer to a request: what the mock sent back, or what a replay target did. */
@Component({
  selector: 'q-mock-response-block',
  imports: [HeaderTable, MockBodyPane],
  template: `
    <p class="text-xs font-medium">{{ title() }}</p>
    @if (headers().length > 0) {
      <div class="max-h-32 overflow-auto"><q-header-table [headers]="headers()" /></div>
    }
    <q-mock-body-pane [body]="body()" [minHeight]="120" />
  `,
  host: { class: 'flex flex-col gap-1 min-h-0' },
})
export class MockResponseBlock {
  readonly title = input.required<string>();
  readonly headers = input.required<[string, string][]>();
  readonly body = input.required<FormattedBody>();
}
