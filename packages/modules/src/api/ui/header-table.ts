import { Component, input } from '@angular/core';

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
  host: { class: 'block overflow-auto h-full text-xs font-mono' },
})
export class HeaderTable {
  readonly headers = input.required<[string, string][]>();
}
