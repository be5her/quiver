import { Component, model } from '@angular/core';
import { CHECK_OPS, CHECK_TARGETS, CHECK_TYPES, newId, type Check, type CheckOp, type CheckTarget } from '@quiver/core';
import { Button, Checkbox, IconButton, Icon, Select } from '@quiver/ui';
import { Plus, Trash2 } from 'lucide';

/** Targets whose value is a number: the text ops make little sense on them, so they come last. */
const NUMERIC: CheckTarget[] = ['status', 'time', 'size'];

/**
 * Assertions run on the response after every send: what to read (the status, a JSON path, a header,
 * the body, the time, the size), how to compare it, and with what (`{{variables}}` resolve).
 * Undefined when there are no rows, so a request without checks has no key.
 */
@Component({
  selector: 'q-check-editor',
  imports: [Button, Checkbox, Icon, IconButton, Select],
  templateUrl: './check-editor.html',
  host: { class: 'block text-sm' },
})
export class CheckEditor {
  readonly value = model<Check[] | undefined>(undefined);

  protected readonly targets = CHECK_TARGETS;
  protected readonly types = CHECK_TYPES;
  protected readonly icons = { Plus, Trash2 };
  protected readonly variableSyntax = '{{name}}';

  protected rows(): Check[] {
    return this.value() ?? [];
  }

  protected ops(on: CheckTarget): { value: CheckOp; label: string }[] {
    if (!NUMERIC.includes(on)) return CHECK_OPS;
    return CHECK_OPS.filter((o) => o.value === 'eq' || o.value === 'neq' || o.value === 'lt' || o.value === 'gt');
  }

  protected hasPath(on: CheckTarget): boolean {
    return on === 'header' || on === 'jsonPath';
  }

  protected pathPlaceholder(on: CheckTarget): string {
    return CHECK_TARGETS.find((t) => t.value === on)?.path ?? '';
  }

  protected expectedPlaceholder(op: CheckOp): string {
    return op === 'matches' ? '^ok' : op === 'exists' ? '' : `value or ${this.variableSyntax}`;
  }

  protected add(): void {
    this.value.set([...this.rows(), { id: newId(), enabled: true, on: 'status', path: '', op: 'eq', expected: '200' }]);
  }

  protected remove(id: string): void {
    const rows = this.rows().filter((r) => r.id !== id);
    this.value.set(rows.length ? rows : undefined);
  }

  protected update(id: string, patch: Partial<Check>): void {
    this.value.set(this.rows().map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** A new target keeps the op when it still applies, and starts on `$` for a JSON path. */
  protected setTarget(row: Check, event: Event): void {
    const on = this.text(event) as CheckTarget;
    const op = this.ops(on).some((o) => o.value === row.op) ? row.op : 'eq';
    this.update(row.id, { on, op, path: on === 'jsonPath' && !row.path ? '$.' : this.hasPath(on) ? row.path : '' });
  }

  protected setOp(row: Check, event: Event): void {
    const op = this.text(event) as CheckOp;
    this.update(row.id, { op, ...(op === 'isType' && !(CHECK_TYPES as readonly string[]).includes(row.expected) ? { expected: 'string' } : {}) });
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
