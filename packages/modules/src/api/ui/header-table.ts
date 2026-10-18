import { Component, booleanAttribute, input } from '@angular/core';

/** Header names and values, one per row. */
@Component({
  selector: 'q-header-table',
  template: `
    <table class="w-full">
      <tbody>
        @for (header of headers(); track $index) {
          <tr class="border-b border-edge/60 align-top">
            <td class="py-1 pr-3 text-muted whitespace-nowrap">{{ header[0] }}</td>
            <td class="py-1 break-all">{{ header[1] }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
  host: { class: 'block text-xs font-mono', '[class.overflow-auto]': '!fit()', '[class.h-full]': '!fit()' },
})
export class HeaderTable {
  readonly headers = input.required<[string, string][]>();
  /** Take the height of the rows instead of filling and scrolling the parent. */
  readonly fit = input(false, { transform: booleanAttribute });
}
