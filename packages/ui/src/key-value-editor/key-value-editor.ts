import { Component, TemplateRef, booleanAttribute, contentChild, input, model } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { NgTemplateOutlet } from '@angular/common';
import { keyValue, type KeyValue } from '@quiver/core';
import { Plus, Trash2 } from 'lucide';
import { IconButton } from '../controls/icon-button';
import { Checkbox } from '../controls/native-controls';
import { Icon } from '../icon/icon';
import { VariableInput } from '../variables/variable-input';

/** What an extra column template receives: `<ng-template let-row let-update="update">`. */
export interface KeyValueExtraContext<T extends KeyValue> {
  $implicit: T;
  update(patch: Partial<T>): void;
}

/**
 * Table editor for params, headers, form fields and variables. Bind the rows with `[formField]` or
 * `[(value)]`. An `<ng-template>` child renders an extra column per row, e.g. a "secret" toggle.
 */
@Component({
  selector: 'q-key-value-editor',
  imports: [Checkbox, Icon, IconButton, NgTemplateOutlet, VariableInput],
  templateUrl: './key-value-editor.html',
  host: { class: 'block text-sm' },
})
export class KeyValueEditor<T extends KeyValue = KeyValue> implements FormValueControl<T[]> {
  readonly value = model<T[]>([]);
  readonly keyPlaceholder = input('Key');
  readonly valuePlaceholder = input('Value');
  readonly extraHeader = input('');
  readonly readonly = input(false, { transform: booleanAttribute });

  protected readonly extra = contentChild<TemplateRef<KeyValueExtraContext<T>>>(TemplateRef);
  protected readonly icons = { Plus, Trash2 };

  protected update(id: string, patch: Partial<T>): void {
    this.value.update((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  protected remove(id: string): void {
    this.value.update((rows) => rows.filter((r) => r.id !== id));
  }

  protected add(): void {
    this.value.update((rows) => [...rows, keyValue() as T]);
  }

  protected setKey(id: string, key: string): void {
    this.update(id, { key } as Partial<T>);
  }

  protected setValue(id: string, value: string): void {
    this.update(id, { value } as Partial<T>);
  }

  protected toggled(id: string, event: Event): void {
    this.update(id, { enabled: (event.target as HTMLInputElement).checked } as Partial<T>);
  }

  protected extraContext(row: T): KeyValueExtraContext<T> {
    return { $implicit: row, update: (patch) => this.update(row.id, patch) };
  }
}
