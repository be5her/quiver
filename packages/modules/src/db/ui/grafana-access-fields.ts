import { Component, computed, inject, model, signal } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import type { DbAccess, GrafanaRedisDatasource, LogsSession } from '@quiver/core';
import { Button, Input, Label, Select, Spinner, invokeResource } from '@quiver/ui';
import { LogIn } from 'lucide';
import { sessionDot, sessionLabel } from '../../logs/ui/logs-format';
import { GrafanaSignIn } from './grafana-signin';

export type GrafanaAccess = Extract<DbAccess, { type: 'grafana' }>;

/**
 * Redis through a Grafana data source: the Grafana address, whether this machine is signed in to it
 * (the same session as Logs), and a picker of the Redis data sources the signed-in user can query.
 */
@Component({
  selector: 'q-grafana-access-fields',
  imports: [Button, Input, Label, Select, Spinner],
  template: `
    @let access = value();
    <div class="flex flex-col gap-3" data-testid="db-grafana-access">
      <div>
        <label qLabel for="db-grafana-url">Grafana address</label>
        <input qInput id="db-grafana-url" class="font-mono" placeholder="https://grafana.example.com" [value]="access.grafanaUrl" data-testid="db-grafana-url" (change)="setUrl($event)" />
      </div>
      @if (templated()) {
        <p class="text-xs text-muted -mt-2">The address holds a variable; it resolves when the connection opens, so sign-in and the data source list wait until then.</p>
      } @else if (access.grafanaUrl) {
        <div class="flex items-center gap-2 min-h-8 -mt-1">
          <span class="size-2 rounded-full shrink-0" [class]="dot()"></span>
          <span class="text-sm" data-testid="db-grafana-session">{{ label() }}</span>
          <span class="flex-1"></span>
          @if (session.value()?.state !== 'signed-in') {
            <button qButton size="sm" variant="primary" [icon]="icons.LogIn" [loading]="signingIn()" data-testid="db-grafana-access-signin" (click)="signIn()">Sign in</button>
          }
        </div>
      }
      <div>
        <label qLabel for="db-grafana-source">Redis data source</label>
        <div class="flex items-center gap-2">
          <select qSelect id="db-grafana-source" class="w-72" data-testid="db-grafana-source" [disabled]="!signedIn() || !options().length" (change)="pick($event)">
            @if (!access.datasourceUid) {
              <option value="" selected>Pick a Redis data source</option>
            }
            @for (d of options(); track d.uid) {
              <option [value]="d.uid" [selected]="d.uid === access.datasourceUid">{{ d.name }}{{ d.cliDisabled ? ' (CLI off: read-only)' : '' }}{{ d.missing ? ' (not found)' : '' }}</option>
            }
          </select>
          @if (sources.isLoading()) {
            <svg qSpinner></svg>
          }
        </div>
        @if (sources.error(); as error) {
          @if (error.code !== 'SIGN_IN_REQUIRED') {
            <p class="text-xs text-danger mt-1">{{ error.message }}</p>
          }
        } @else if (moved(); as moved) {
          <p class="text-xs text-warning mt-1" data-testid="db-grafana-moved">
            Grafana no longer has uid {{ access.datasourceUid }}, but {{ moved.name }} is there as {{ moved.uid }}.
            <button type="button" class="underline" data-testid="db-grafana-moved-use" (click)="use(moved)">Use it</button>
          </p>
        } @else if (signedIn() && sources.value()?.length === 0) {
          <p class="text-xs text-muted mt-1">This Grafana has no Redis data source (redis-datasource plugin) you can query.</p>
        } @else if (!signedIn() && !templated()) {
          <p class="text-[11px] text-muted mt-1">Sign in to list the data sources.</p>
        }
      </div>
      <p class="text-xs text-muted">
        Every command goes to Grafana's <code class="font-mono">/api/ds/query</code> through the plugin's CLI and runs with the permissions of the Grafana user signed in on this machine. The
        plugin does not limit commands; Quiver's write confirmation and agent gating still apply. Nothing secret is stored, so teammates sign in with their own account.
      </p>
    </div>
  `,
  host: { class: 'block' },
})
export class GrafanaAccessFields implements FormValueControl<GrafanaAccess> {
  private readonly grafana = inject(GrafanaSignIn);

  readonly value = model.required<GrafanaAccess>();

  protected readonly icons = { LogIn };
  protected readonly signingIn = signal(false);
  protected readonly templated = computed(() => this.value().grafanaUrl.includes('{{'));
  protected readonly session = invokeResource<LogsSession>('db.grafana.session', () => ({ grafanaUrl: this.value().grafanaUrl }), {
    enabled: () => Boolean(this.value().grafanaUrl) && !this.templated(),
    refreshOnEvents: ['grafana.changed'],
  });
  protected readonly signedIn = computed(() => this.session.value()?.state === 'signed-in');
  protected readonly dot = computed(() => sessionDot(this.session.value() ?? { state: 'unknown', user: null, error: null, checkedAt: null }));
  protected readonly label = computed(() => {
    const s = this.session.value();
    if (this.session.error()) return this.session.error()!.message;
    if (!s) return 'Checking…';
    return s.state === 'signed-in' ? `Signed in as ${s.user?.email || s.user?.login}` : sessionLabel(s);
  });
  protected readonly sources = invokeResource<GrafanaRedisDatasource[]>('db.grafana.redis.datasources', () => ({ grafanaUrl: this.value().grafanaUrl }), {
    enabled: () => this.signedIn(),
  });
  /** The saved data source stays listed when Grafana no longer offers it. */
  protected readonly options = computed(() => {
    const list: (GrafanaRedisDatasource & { missing?: boolean })[] = this.sources.value() ?? [];
    const a = this.value();
    return a.datasourceUid && !list.some((d) => d.uid === a.datasourceUid) ? [{ uid: a.datasourceUid, name: a.datasourceName || a.datasourceUid, cliDisabled: false, missing: this.sources.value() !== undefined }, ...list] : list;
  });
  /** The saved uid is gone but a data source of the saved name is there: provisioned anew. */
  protected readonly moved = computed(() => {
    const list = this.sources.value();
    const a = this.value();
    if (!list || !a.datasourceUid || list.some((d) => d.uid === a.datasourceUid)) return null;
    return list.find((d) => d.name === a.datasourceName) ?? null;
  });

  protected setUrl(event: Event): void {
    this.value.update((a) => ({ ...a, grafanaUrl: (event.target as HTMLInputElement).value.trim() }));
  }

  protected pick(event: Event): void {
    const source = this.sources.value()?.find((d) => d.uid === (event.target as HTMLSelectElement).value);
    if (source) this.use(source);
  }

  protected use(source: GrafanaRedisDatasource): void {
    this.value.update((a) => ({ ...a, datasourceUid: source.uid, datasourceName: source.name }));
  }

  protected async signIn(): Promise<void> {
    this.signingIn.set(true);
    try {
      await this.grafana.signIn(this.value().grafanaUrl);
      this.session.reload();
    } finally {
      this.signingIn.set(false);
    }
  }
}
