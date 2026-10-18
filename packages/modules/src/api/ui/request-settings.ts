import { Component, computed, inject, model } from '@angular/core';
import { SendOptionsSchema, effectiveSendOptions, requestOptionOverrides, type RequestOptions, type SendOptions } from '@quiver/core';
import { Button, Checkbox, HostBridge, Input, invokeResource } from '@quiver/ui';
import { RotateCcw } from 'lucide';

const MB = 1024 * 1024;

/**
 * How a request is sent: timeout, redirects, certificate checks and the body cap. Shows the value in
 * effect and keeps only what differs from the defaults, so a saved request carries just its overrides.
 */
@Component({
  selector: 'q-request-settings',
  imports: [Button, Checkbox, Input],
  templateUrl: './request-settings.html',
  host: { class: 'block text-sm' },
})
export class RequestSettings {
  readonly value = model<RequestOptions | undefined>(undefined);

  protected readonly icons = { RotateCcw };
  protected readonly defaults = SendOptionsSchema.parse({});
  protected readonly effective = computed(() => effectiveSendOptions(this.value()));
  protected readonly defaultSeconds = this.defaults.timeoutMs / 1000;
  protected readonly defaultMegabytes = this.defaults.maxBodyBytes / MB;

  private readonly host = inject(HostBridge);
  private readonly keep = invokeResource<{ value: boolean | null }>('workspace.state.get', () => ({ key: 'api.history.keepResponses' }), { refreshOnState: ['api.history.keepResponses'] });
  /** A workspace setting rather than the request's: whether sends keep their response in the history. */
  protected readonly keepResponses = computed(() => this.keep.value()?.value !== false);

  protected setKeepResponses(on: boolean): void {
    void this.host.invoke('workspace.state.set', { key: 'api.history.keepResponses', value: on });
  }

  protected isSet(key: keyof SendOptions): boolean {
    return this.value()?.[key] !== undefined;
  }

  protected set<K extends keyof SendOptions>(key: K, value: SendOptions[K] | undefined): void {
    this.value.set(requestOptionOverrides({ ...this.value(), [key]: value }));
  }

  protected seconds(): string {
    const ms = this.value()?.timeoutMs;
    return ms === undefined ? '' : String(ms / 1000);
  }

  protected megabytes(): string {
    const bytes = this.value()?.maxBodyBytes;
    return bytes === undefined ? '' : String(Math.round((bytes / MB) * 100) / 100);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  /** An empty field goes back to the default; anything but a positive number is put back as it was. */
  protected setNumber(event: Event, key: 'timeoutMs' | 'maxBodyBytes', unit: number): void {
    const input = event.target as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return this.set(key, undefined);
    const n = Number(text);
    const value = Math.round(n * unit);
    if (!Number.isFinite(n) || value < 1) {
      input.value = key === 'timeoutMs' ? this.seconds() : this.megabytes();
      return;
    }
    this.set(key, value);
  }

  protected resetAll(): void {
    this.value.set(undefined);
  }
}
