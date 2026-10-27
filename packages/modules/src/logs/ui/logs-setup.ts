import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { LogsAuthKind, LogsConnectionDraft, LogsConnectionKind, LogsConnectionSummary, LogsConnectionTest, LogsDatasource } from '@quiver/core';
import { Button, HostBridge, Input, Label, Segment, Segmented, Select, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { KeyRound, LogIn, LogOut, PlugZap, Trash2 } from 'lucide';
import { LogsActions } from './logs-actions';
import { directLabel, sessionDot, sessionLabel } from './logs-format';

/**
 * Where the connection points: through Grafana (the address, the sign-in on this machine and the data
 * source) or a VictoriaLogs server directly (the address, tenant and credentials). Every change saves.
 */
@Component({
  selector: 'q-logs-setup',
  imports: [Button, Input, Label, Segment, Segmented, Select, Spinner],
  template: `
    @let c = conn();
    <div class="max-w-xl flex flex-col gap-4 p-4" data-testid="logs-setup" [attr.data-kind]="c.kind">
      <div>
        <label qLabel for="logs-name">Name</label>
        <input qInput id="logs-name" [value]="c.name" (change)="save({ name: value($event) })" data-testid="logs-name" />
      </div>
      <div>
        <span qLabel>Connect</span>
        <q-segmented [value]="c.kind" (valueChange)="pickKind($event)" data-testid="logs-kind">
          <button qSegment="grafana" data-testid="logs-kind-grafana">Through Grafana</button>
          <button qSegment="victorialogs" data-testid="logs-kind-victorialogs">VictoriaLogs directly</button>
        </q-segmented>
      </div>

      @if (c.kind === 'victorialogs') {
        <div>
          <label qLabel for="logs-vl-url">VictoriaLogs address</label>
          <input qInput id="logs-vl-url" class="font-mono" placeholder="http://localhost:9428" [value]="c.url" (change)="save({ url: value($event) })" data-testid="logs-vl-url" />
          <p class="text-[11px] text-muted mt-1">The server itself (port 9428 by default), or a proxy in front of it; a sub-path is kept. Quiver calls its <code>/select/logsql</code> API.</p>
        </div>
        <div>
          <span qLabel>Tenant (optional)</span>
          <div class="flex items-center gap-2">
            <input #account qInput id="logs-vl-account" type="number" min="0" step="1" class="w-32" placeholder="AccountID" aria-label="Tenant account id" [value]="c.tenant?.accountId ?? ''" (change)="saveTenant(account.value, project.value)" data-testid="logs-vl-account" />
            <span class="text-muted">:</span>
            <input #project qInput id="logs-vl-project" type="number" min="0" step="1" class="w-32" placeholder="ProjectID" aria-label="Tenant project id" [value]="c.tenant?.projectId ?? ''" (change)="saveTenant(account.value, project.value)" data-testid="logs-vl-project" />
          </div>
          <p class="text-[11px] text-muted mt-1">Sent as the AccountID and ProjectID headers. Leave both empty for the default tenant.</p>
        </div>
        <div>
          <span qLabel>Authentication</span>
          <q-segmented [value]="c.auth" (valueChange)="pickAuth($event)" data-testid="logs-vl-auth">
            <button qSegment="none" data-testid="logs-vl-auth-none">None</button>
            <button qSegment="basic" data-testid="logs-vl-auth-basic">Basic</button>
            <button qSegment="bearer" data-testid="logs-vl-auth-bearer">Bearer token</button>
          </q-segmented>
        </div>
        @if (c.auth !== 'none') {
          @if (c.auth === 'basic') {
            <div>
              <label qLabel for="logs-vl-username">Username</label>
              <input qInput id="logs-vl-username" class="w-72" autocomplete="off" [value]="c.authUsername ?? ''" (change)="save({ authUsername: value($event) })" data-testid="logs-vl-username" />
            </div>
          }
          <div>
            <label qLabel for="logs-vl-secret">{{ c.auth === 'basic' ? 'Password' : 'Token' }}</label>
            @if (c.hasSecret && !changingSecret()) {
              <div class="flex items-center gap-2 min-h-8">
                <span class="text-xs text-success" data-testid="logs-vl-secret-state">Stored on this machine</span>
                <button qButton size="sm" variant="ghost" data-testid="logs-vl-secret-change" (click)="changingSecret.set(true)">Change</button>
                <button qButton size="sm" variant="ghost" data-testid="logs-vl-secret-clear" (click)="clearSecret()">Clear</button>
              </div>
            } @else {
              <div class="flex items-center gap-2">
                <input
                  qInput
                  id="logs-vl-secret"
                  type="password"
                  autocomplete="off"
                  class="font-mono flex-1"
                  [placeholder]="c.hasSecret ? 'A new one replaces the stored one' : ''"
                  [value]="secret()"
                  (input)="secret.set(value($event))"
                  (keydown.enter)="saveSecret()"
                  data-testid="logs-vl-secret"
                />
                <button qButton size="sm" variant="primary" [icon]="icons.KeyRound" [loading]="saving()" [disabled]="!secret()" data-testid="logs-vl-secret-save" (click)="saveSecret()">Save</button>
                @if (c.hasSecret) {
                  <button qButton size="sm" variant="ghost" (click)="changingSecret.set(false); secret.set('')">Cancel</button>
                }
              </div>
            }
            <p class="text-[11px] text-muted mt-1">Kept encrypted on this machine, never in the project, and not shown again.</p>
          </div>
        }
        <div class="flex items-center gap-2 flex-wrap min-h-8">
          <button qButton size="sm" variant="secondary" [icon]="icons.PlugZap" [loading]="testing()" [disabled]="!c.url" data-testid="logs-test" (click)="test()">Test</button>
          @if (testResult(); as r) {
            <span class="text-xs" [class]="r.ok ? 'text-success' : 'text-danger'" data-testid="logs-test-result" [attr.data-ok]="r.ok">{{ testText(r) }}</span>
          } @else {
            <span class="size-2 rounded-full shrink-0" [class]="dot()"></span>
            <span class="text-xs text-muted" data-testid="logs-session">{{ label() }}</span>
          }
        </div>
        <p class="text-[11px] text-muted -mt-2">The project file holds the address, tenant, authentication kind and username; the password or token stays on this machine, so teammates enter their own.</p>
      } @else {
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
      }
      <div class="flex items-center gap-2 pt-2 border-t border-edge">
        @if (ready()) {
          <button qButton size="sm" variant="primary" data-testid="logs-setup-done" (click)="done.emit()">Done</button>
        }
        <span class="flex-1"></span>
        <button qButton size="sm" variant="danger" [icon]="icons.Trash2" data-testid="logs-delete" (click)="logs.deleteConnection(c)">Delete connection</button>
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

  protected readonly icons = { KeyRound, LogIn, LogOut, PlugZap, Trash2 };
  protected readonly dot = computed(() => sessionDot(this.conn().session));
  protected readonly label = computed(() => {
    const c = this.conn();
    if (c.kind === 'victorialogs') return c.url ? directLabel(c.session) : 'Enter the VictoriaLogs address first';
    const s = c.session;
    return s.state === 'signed-in' ? `Signed in as ${s.user?.email || s.user?.login}` : c.grafanaUrl ? sessionLabel(s) : 'Enter the Grafana address first';
  });
  protected readonly ready = computed(() => {
    const c = this.conn();
    return c.kind === 'victorialogs' ? Boolean(c.url) : Boolean(c.grafanaUrl && c.datasourceUid);
  });
  protected readonly sources = invokeResource<LogsDatasource[]>('logs.datasources', () => ({ id: this.conn().id, url: this.conn().grafanaUrl }), {
    enabled: () => this.conn().kind !== 'victorialogs' && this.conn().session.state === 'signed-in',
  });
  /** The saved data source stays listed even when Grafana no longer offers it. */
  protected readonly options = computed(() => {
    const list = this.sources.value() ?? [];
    const c = this.conn();
    return c.datasourceUid && !list.some((d) => d.uid === c.datasourceUid) ? [{ uid: c.datasourceUid, name: c.datasourceName || c.datasourceUid, type: c.datasourceType }, ...list] : list;
  });
  protected readonly saving = signal(false);
  protected readonly secret = signal('');
  protected readonly changingSecret = signal(false);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<LogsConnectionTest | null>(null);

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected testText(r: LogsConnectionTest): string {
    if (!r.ok) return r.error ?? 'Failed';
    return `Connected${r.version ? ` · ${r.version}` : ''} · ${r.tookMs} ms`;
  }

  protected pickKind(kind: string): void {
    if (kind === this.conn().kind) return;
    this.testResult.set(null);
    void this.save({ kind: kind as LogsConnectionKind });
  }

  protected pickAuth(auth: string): void {
    if (auth === this.conn().auth) return;
    this.testResult.set(null);
    void this.save({ auth: auth as LogsAuthKind });
  }

  protected saveTenant(accountText: string, projectText: string): void {
    const account = accountText.trim();
    const project = projectText.trim();
    void this.save({ tenant: account === '' && project === '' ? null : { accountId: Number(account || 0), projectId: Number(project || 0) } });
  }

  protected async saveSecret(): Promise<void> {
    const secret = this.secret();
    if (!secret) return;
    if (await this.save({}, secret)) {
      this.secret.set('');
      this.changingSecret.set(false);
    }
  }

  protected async clearSecret(): Promise<void> {
    await this.save({}, '');
  }

  protected async test(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    try {
      this.testResult.set(await this.host.invoke<LogsConnectionTest>('logs.connection.test', { id: this.conn().id }));
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.testing.set(false);
    }
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

  /** Save a change (and the secret when one is given); resolves to whether it was saved. */
  protected async save(patch: LogsConnectionDraft, secret?: string): Promise<boolean> {
    if (this.saving()) return false;
    this.saving.set(true);
    try {
      if (secret !== undefined || Object.keys(patch).some((k) => k !== 'name')) this.testResult.set(null);
      this.saved.emit(await this.host.invoke<LogsConnectionSummary>('logs.connection.save', { connection: { id: this.conn().id, ...patch }, ...(secret === undefined ? {} : { secret }) }));
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}
