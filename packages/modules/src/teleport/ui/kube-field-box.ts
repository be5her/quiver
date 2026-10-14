import { Component, booleanAttribute, input } from '@angular/core';

/**
 * A labelled field with one line below it: the validation error, else the projected `[fieldWarning]`
 * when `warn` is set, else an empty line so the row does not jump.
 */
@Component({
  selector: 'q-kube-field-box',
  template: `
    <span class="text-[11px] font-medium text-muted">{{ label() }}</span>
    <ng-content />
    @if (error(); as error) {
      <span class="text-[11px] h-3.5 leading-3.5 truncate text-danger" [title]="error">{{ error }}</span>
    } @else if (warn()) {
      <span class="text-[11px] h-3.5 leading-3.5 truncate text-warning" data-testid="kube-field-warning"><ng-content select="[fieldWarning]" /></span>
    } @else {
      <span class="h-3.5"></span>
    }
  `,
  host: { class: 'flex flex-col gap-1 min-w-0' },
})
export class KubeFieldBox {
  readonly label = input.required<string>();
  readonly error = input<string>();
  readonly warn = input(false, { transform: booleanAttribute });
}
