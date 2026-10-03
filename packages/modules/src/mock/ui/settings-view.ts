import { Component, computed, input, output } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import type { KeyValue, MockFallback, MockServer } from '@quiver/core';
import { Button, Checkbox, CodeEditor, Input, KeyValueEditor, Label, Select } from '@quiver/ui';
import { Trash2 } from 'lucide';
import { clampInt } from './mock-format';

/** Where the server listens, what it keeps, and how it answers requests no route matches. */
@Component({
  selector: 'q-mock-settings-view',
  imports: [Button, Checkbox, CodeEditor, FormField, Input, KeyValueEditor, Label, Select],
  templateUrl: './settings-view.html',
  host: { class: 'flex flex-col gap-4 p-3 overflow-y-auto h-full max-w-3xl' },
})
export class MockSettingsView {
  readonly form = input.required<FieldTree<MockServer>>();
  readonly remove = output<void>();

  protected readonly trash = Trash2;
  protected readonly server = computed(() => this.form()().value());
  protected readonly fallback = computed(() => this.server().fallback);
  protected readonly fallbackLanguage = computed(() => {
    const fallback = this.fallback();
    return fallback.type === 'respond' && /^\s*[[{]/.test(fallback.body) ? 'json' : 'text';
  });

  protected setPort(event: Event): void {
    this.form().port().value.set(clampInt((event.target as HTMLInputElement).value, 0, 65535, 0));
  }

  protected setLogLimit(event: Event): void {
    this.form().logLimit().value.set(clampInt((event.target as HTMLInputElement).value, 10, 5000, 500));
  }

  protected setFallbackType(event: Event): void {
    const type = (event.target as HTMLSelectElement).value;
    this.setFallback(type === 'forward' ? { type: 'forward', url: '' } : { type: 'respond', status: 404, headers: [], body: '{"error":"no mock route matched"}' });
  }

  protected setFallbackStatus(event: Event): void {
    this.patchFallback({ status: clampInt((event.target as HTMLInputElement).value, 100, 599, 404) });
  }

  protected setFallbackHeaders(headers: KeyValue[]): void {
    this.patchFallback({ headers });
  }

  protected setFallbackBody(body: string): void {
    this.patchFallback({ body });
  }

  protected setForwardUrl(event: Event): void {
    const fallback = this.fallback();
    if (fallback.type === 'forward') this.setFallback({ ...fallback, url: (event.target as HTMLInputElement).value });
  }

  private patchFallback(patch: Partial<Extract<MockFallback, { type: 'respond' }>>): void {
    const fallback = this.fallback();
    if (fallback.type === 'respond') this.setFallback({ ...fallback, ...patch });
  }

  private setFallback(next: MockFallback): void {
    this.form().fallback().value.set(next);
  }
}
