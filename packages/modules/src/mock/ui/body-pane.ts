import { Component, input } from '@angular/core';
import { CodeEditor } from '@quiver/ui';
import type { FormattedBody } from './mock-format';

/** A captured body, read-only, with a note when it was cut or is binary. */
@Component({
  selector: 'q-mock-body-pane',
  imports: [CodeEditor],
  template: `
    @let b = body();
    @if (!b.text && !b.note) {
      <p class="text-xs text-muted px-1">Empty body.</p>
    } @else {
      <div class="flex flex-col gap-1 h-full min-h-0">
        @if (b.note) {
          <p class="text-[11px] text-warning px-1">{{ b.note }}</p>
        }
        @if (b.text) {
          <div class="flex-1 min-h-0" [style.min-height.px]="minHeight()">
            <q-code-editor [value]="b.text" readonly [language]="b.language" [wrap]="b.language !== 'json'" />
          </div>
        }
      </div>
    }
  `,
  host: { class: 'contents' },
})
export class MockBodyPane {
  readonly body = input.required<FormattedBody>();
  readonly minHeight = input(200);
}
