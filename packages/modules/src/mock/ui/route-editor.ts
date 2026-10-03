import { Component, booleanAttribute, computed, input, model, output } from '@angular/core';
import { FormField, form, type FormValueControl } from '@angular/forms/signals';
import { MockMethodSchema, type MockRoute } from '@quiver/core';
import { Checkbox, CodeEditor, Icon, IconButton, Input, KeyValueEditor, Label, Select } from '@quiver/ui';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide';
import { TEMPLATE_HINT, bodyLanguage, clampInt } from './mock-format';

/** One route: when it matches, and the status, headers and templated body it answers with. */
@Component({
  selector: 'q-mock-route-editor',
  imports: [Checkbox, CodeEditor, FormField, Icon, IconButton, Input, KeyValueEditor, Label, Select],
  templateUrl: './route-editor.html',
  host: { class: 'flex flex-col gap-3 p-3', 'data-testid': 'mock-route-editor' },
})
export class MockRouteEditor implements FormValueControl<MockRoute> {
  readonly value = model.required<MockRoute>();
  readonly canUp = input(false, { transform: booleanAttribute });
  readonly canDown = input(false, { transform: booleanAttribute });
  readonly moved = output<-1 | 1>();
  readonly removed = output<void>();

  protected readonly icons = { ArrowDown, ArrowUp, Trash2 };
  protected readonly methods = MockMethodSchema.options;
  protected readonly templateHint = TEMPLATE_HINT;
  protected readonly routeForm = form(this.value);
  protected readonly language = computed(() => bodyLanguage(this.value().body));

  protected setStatus(event: Event): void {
    this.value.update((route) => ({ ...route, status: clampInt((event.target as HTMLInputElement).value, 100, 599, 200) }));
  }

  protected setDelay(event: Event): void {
    this.value.update((route) => ({ ...route, delayMs: clampInt((event.target as HTMLInputElement).value, 0, 120_000, 0) }));
  }
}
