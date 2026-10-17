import { Component, model } from '@angular/core';
import { newId, type Capture, type CaptureSource } from '@quiver/core';
import { Button, Checkbox, IconButton, Icon, Select } from '@quiver/ui';
import { Plus, Trash2 } from 'lucide';

const SOURCES: { value: CaptureSource; label: string; placeholder: string }[] = [
  { value: 'body', label: 'Body', placeholder: '$.token (empty for the whole body)' },
  { value: 'header', label: 'Header', placeholder: 'X-Request-Id' },
  { value: 'cookie', label: 'Cookie', placeholder: 'session' },
  { value: 'status', label: 'Status', placeholder: '' },
];

/**
 * The values a send takes from its response into environment variables: each row names the
 * variable, where to read it (a JSON path into the body, a header, a cookie, the status) and
 * whether it is secret. Undefined when there are no rows, so a request without captures has no key.
 */
@Component({
  selector: 'q-capture-editor',
  imports: [Button, Checkbox, Icon, IconButton, Select],
  templateUrl: './capture-editor.html',
  host: { class: 'block text-sm' },
})
export class CaptureEditor {
  readonly value = model<Capture[] | undefined>(undefined);

  protected readonly sources = SOURCES;
  protected readonly icons = { Plus, Trash2 };
  protected readonly variableSyntax = '{{name}}';

  protected rows(): Capture[] {
    return this.value() ?? [];
  }

  protected placeholder(from: CaptureSource): string {
    return SOURCES.find((s) => s.value === from)?.placeholder ?? '';
  }

  protected add(): void {
    this.value.set([...this.rows(), { id: newId(), enabled: true, variable: '', from: 'body', path: '', secret: false }]);
  }

  protected remove(id: string): void {
    const rows = this.rows().filter((r) => r.id !== id);
    this.value.set(rows.length ? rows : undefined);
  }

  protected update(id: string, patch: Partial<Capture>): void {
    this.value.set(this.rows().map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected source(event: Event): CaptureSource {
    return this.text(event) as CaptureSource;
  }
}
