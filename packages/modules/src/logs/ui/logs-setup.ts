import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { LogsConnectionDraft, LogsConnectionSummary, LogsDatasource } from '@quiver/core';
import { Button, HostBridge, Input, Label, Select, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { LogIn, LogOut, Trash2 } from 'lucide';
import { LogsActions } from './logs-actions';
import { sessionDot, sessionLabel } from './logs-format';

/** Where the connection points: the Grafana address, the sign-in on this machine and the data source. Every change saves. */
@Component({
  selector: 'q-logs-setup',
  imports: [Button, Input, Label, Select, Spinner],
  template: `
    @let c = conn();
    <div class="max-w-xl flex flex-col gap-4 p-4" data-testid="logs-setup">
      <div>
        <label qLabel for="logs-name">Name</label>
        <input qInput id="logs-name" [value]="c.name" (change)="save({ name: value($event) })" data-testid="logs-name" />
      </div>
      <div>
        <label qLabel for="logs-grafana">Grafana address</label>
        <input qInput id="logs-grafana" class="font-mono" placeholder="https://grafana.example.com" [value]="c.grafanaUrl" (change)="save({ grafanaUrl: value($event) })" data-testid="logs-grafana-url" />
        <p class="text-[11px] text-muted mt-1">The Grafana you open VictoriaLogs in. Quiver queries through it, so its data sources, tenants and permissions apply as they do in Explore.</p>
      </div>
      <div class="flex items-center gap-2 min-h-8">
        <span class="size-2 rounded-full shrink-0" [class]="dot()"></span>
        <span class="text-sm" data-testid="logs-session">{{ label() }}</span>
        <span class="flex-1"></span>
        @if (c.session.state === 'signed-in') {
          <button qButton size="sm" variant="ghost" [icon]="icons.LogOut" (click)="logs.signOut(c)">Sign out</button>
        } @else {
          <button qButton size="sm" variant="primary" [icon]="icons.LogIn" [loading]="c.session.state === 'signing-in'" [disabled]="!c.grafanaUrl" data-testid="logs-signin" (click)="logs.signIn(c)">Sign in</button>
        }
      </div>
      @if (c.session.error) {
        <p class="text-xs text-danger -mt-2">{{ c.session.error }}</p>
      }
      <p class="text-[11px] text-muted -mt-2">Sign in opens Grafana's login page in a window; use the account you use in the browser. The session is kept on this machine only, renewed while you use it, and shared by every connection to this Grafana.</p>
      <div>
        <label qLabel for="logs-datasource">Data source</label>
        <div class="flex items-center gap-2">
          <select qSelect id="logs-datasource" class="w-72" [disabled]="c.session.state !== 'signed-in' || !sources.value()?.length" (change)="pickSource($event)" data-testid="logs-datasource">
            @if (!c.datasourceUid) {
              <option value="" selected>Pick a VictoriaLogs data source</option>
            }
            @for (d of options(); track d.uid) {
              <option [value]="d.uid" [selected]="d.uid === c.datasourceUid">{{ d.name }}</option>
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
        } @else if (c.session.state === 'signed-in' && sources.value()?.length === 0) {
          <p class="text-xs text-muted mt-1">This Grafana has no VictoriaLogs data source you can query.</p>
        } @else if (c.session.state !== 'signed-in') {
          <p class="text-[11px] text-muted mt-1">Sign in to list the data sources.</p>
        }
      </div>
      <div class="flex items-center gap-2 pt-2 border-t border-edge">
        @if (c.grafanaUrl && c.datasourceUid) {
          <button qButton size="sm" variant="primary" data-testid="logs-setup-done" (click)="done.emit()">Done</button>
        }
        <span class="flex-1"></span>
        <button qButton size="sm" variant="danger" [icon]="icons.Trash2" (click)="logs.deleteConnection(c)">Delete connection</button>
      </div>
    </div>
  `,
  host: { class: 'block h-full overflow-y-auto' },
})
export class LogsSetup {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  protected readonly logs = inject(LogsActions);

  readonly conn = input.required<LogsConnectionSummary>();
  readonly saved = output<LogsConnectionSummary>();
  readonly done = output<void>();

  protected readonly icons = { LogIn, LogOut, Trash2 };
  protected readonly dot = computed(() => sessionDot(this.conn().session));
  protected readonly label = computed(() => {
    const s = this.conn().session;
    return s.state === 'signed-in' ? `Signed in as ${s.user?.email || s.user?.login}` : this.conn().grafanaUrl ? sessionLabel(s) : 'Enter the Grafana address first';
  });
  protected readonly sources = invokeResource<LogsDatasource[]>('logs.datasources', () => ({ id: this.conn().id, url: this.conn().grafanaUrl }), {
    enabled: () => this.conn().session.state === 'signed-in',
  });
  /** The saved data source stays listed even when Grafana no longer offers it. */
  protected readonly options = computed(() => {
    const list = this.sources.value() ?? [];
    const c = this.conn();
    return c.datasourceUid && !list.some((d) => d.uid === c.datasourceUid) ? [{ uid: c.datasourceUid, name: c.datasourceName || c.datasourceUid, type: c.datasourceType }, ...list] : list;
  });
  private readonly saving = signal(false);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected pickSource(event: Event): void {
    const uid = (event.target as HTMLSelectElement).value;
    const source = this.sources.value()?.find((d) => d.uid === uid);
    if (!source) return;
    const c = this.conn();
    // A connection still named after its old data source (or not named at all) takes the new one's name.
    const rename = !c.name.trim() || c.name === 'Logs' || c.name === c.datasourceName;
    void this.save({ datasourceUid: source.uid, datasourceName: source.name, datasourceType: source.type, ...(rename ? { name: source.name } : {}) });
  }

  protected async save(patch: LogsConnectionDraft): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      this.saved.emit(await this.host.invoke<LogsConnectionSummary>('logs.connection.save', { connection: { id: this.conn().id, ...patch } }));
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }
}
