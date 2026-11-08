import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import {
  MetabaseAuthSchema,
  describeMetabaseConnection,
  toErrorPayload,
  type MetabaseConnectionDraft,
  type MetabaseConnectionSummary,
  type MetabaseSession,
  type MetabaseTestResult,
} from '@quiver/core';
import { Button, HostBridge, Icon, Input, Label, Segment, Segmented, Spinner, TabsState, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { ChartColumnBig, KeyRound, LogIn, LogOut, PlugZap, SquareTerminal, Trash2 } from 'lucide';
import { MetabaseActions } from './metabase-actions';
import { connectionSessionText, mbSessionDot } from './metabase-format';

/**
 * A Metabase connection: its name and address, and how this machine gets in, either a sign-in in a
 * Quiver window or an API key kept encrypted on this machine. Every change saves; the key is sent
 * once and never read back.
 */
@Component({
  selector: 'q-mb-connection-tab',
  imports: [Button, Icon, Input, Label, Segment, Segmented, Spinner],
  template: `
    @if (summary.error(); as error) {
      <div class="p-4 text-sm text-danger">{{ error.message }}</div>
    } @else if (summary.value(); as c) {
      <div class="flex flex-col h-full min-h-0 w-full" data-testid="mb-connection-tab" [attr.data-session]="c.session.state" [attr.data-auth]="c.auth">
        <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
          <svg [qIcon]="icons.ChartColumnBig" class="size-4 text-accent shrink-0"></svg>
          <span class="font-medium text-sm shrink-0 truncate max-w-64">{{ c.name }}</span>
          <span class="text-xs text-muted truncate min-w-0" [title]="c.url">{{ where() }}</span>
          <span class="flex-1 min-w-4"></span>
          <button qButton size="sm" variant="ghost" [icon]="icons.SquareTerminal" [disabled]="!c.url" (click)="metabase.openQuery(c)">New query</button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div class="max-w-xl flex flex-col gap-4 p-4">
            <div>
              <label qLabel for="mb-name">Name</label>
              <input qInput id="mb-name" [value]="c.name" (change)="save({ name: value($event) })" data-testid="mb-name" />
            </div>
            <div>
              <label qLabel for="mb-url">Metabase address</label>
              <input qInput id="mb-url" class="font-mono" placeholder="https://metabase.example.com" [value]="c.url" (change)="save({ url: value($event) })" data-testid="mb-url" />
              <p class="text-[11px] text-muted mt-1">The address you open Metabase at (Metabase 49 or later). Questions, databases and permissions are Metabase's, as for the account Quiver gets in with.</p>
            </div>
            <div>
              <span qLabel>Sign in with</span>
              <q-segmented [value]="c.auth" (valueChange)="pickAuth($event)" data-testid="mb-auth-mode">
                <button qSegment="browser" data-testid="mb-auth-browser">Browser sign-in</button>
                <button qSegment="apikey" data-testid="mb-auth-apikey">API key</button>
              </q-segmented>
            </div>

            @if (c.auth === 'browser') {
              <div class="flex items-center gap-2 min-h-8 -mt-1">
                <span class="size-2 rounded-full shrink-0" [class]="dot()"></span>
                <span class="text-sm" data-testid="mb-session">{{ sessionText() }}</span>
                <span class="flex-1"></span>
                @if (c.session.state === 'signed-in') {
                  <button qButton size="sm" variant="ghost" [icon]="icons.LogOut" data-testid="mb-signout" (click)="signOut(c)">Sign out</button>
                } @else {
                  <button qButton size="sm" variant="primary" [icon]="icons.LogIn" [loading]="c.session.state === 'signing-in' || signingIn()" [disabled]="!c.url" data-testid="mb-signin" (click)="signIn(c)">Sign in</button>
                }
              </div>
              @if (c.session.error) {
                <p class="text-xs text-danger -mt-2">{{ c.session.error }}</p>
              }
              <p class="text-[11px] text-muted -mt-2">Sign in opens Metabase's login page in a window; use the account you use in the browser (SSO works). The session is kept on this machine only and shared by every workspace that uses this server.</p>
            } @else {
              <div class="flex flex-col gap-2 -mt-1">
                <div class="flex items-center gap-2 min-h-8">
                  <span class="size-2 rounded-full shrink-0" [class]="dot()"></span>
                  <span class="text-sm" data-testid="mb-session">{{ sessionText() }}</span>
                </div>
                <div>
                  <label qLabel for="mb-apikey">API key</label>
                  <div class="flex items-center gap-2">
                    <input
                      qInput
                      id="mb-apikey"
                      type="password"
                      class="font-mono flex-1"
                      [placeholder]="c.hasApiKey ? 'Paste a new key to replace the stored one' : 'mb_…'"
                      [value]="apiKey()"
                      (input)="apiKey.set(value($event))"
                      (keydown.enter)="saveKey(c)"
                      data-testid="mb-apikey"
                    />
                    <button qButton size="sm" variant="primary" [icon]="icons.KeyRound" [loading]="savingKey()" [disabled]="!apiKey().trim()" data-testid="mb-apikey-save" (click)="saveKey(c)">Save key</button>
                  </div>
                  <div class="flex items-center gap-2 mt-1 min-h-7">
                    <span class="text-[11px]" [class]="c.hasApiKey ? 'text-success' : 'text-muted'" data-testid="mb-apikey-state">{{ c.hasApiKey ? 'Key stored on this machine' : 'No key on this machine' }}</span>
                    @if (c.hasApiKey) {
                      <button qButton size="sm" variant="ghost" data-testid="mb-apikey-clear" (click)="clearKey(c)">Clear</button>
                    }
                  </div>
                </div>
                @if (c.session.error) {
                  <p class="text-xs text-danger">{{ c.session.error }}</p>
                }
                <p class="text-[11px] text-muted">An admin creates API keys in Metabase under Admin settings, Authentication, API keys; the key acts as its group. It is kept encrypted on this machine, never in the project, and Quiver does not show it again.</p>
              </div>
            }

            <div class="flex items-center gap-2 flex-wrap">
              <button qButton size="sm" variant="secondary" [icon]="icons.PlugZap" [loading]="testing()" [disabled]="!c.url" data-testid="mb-test" (click)="test(c)">Test</button>
              @if (testResult(); as r) {
                <span class="text-xs" [class]="r.ok ? 'text-success' : 'text-danger'" data-testid="mb-test-result" [attr.data-ok]="r.ok">{{ r.message }}</span>
              }
            </div>

            <p class="text-[11px] text-muted">The project file holds only the name, the address and the sign-in method: nothing secret is committed, so teammates sign in with their own account or key.</p>

            <div class="flex items-center gap-2 pt-2 border-t border-edge">
              <span class="flex-1"></span>
              <button qButton size="sm" variant="danger" [icon]="icons.Trash2" data-testid="mb-delete" (click)="metabase.deleteConnection(c)">Delete connection</button>
            </div>
          </div>
        </div>
      </div>
    } @else {
      <div class="flex items-center justify-center h-full w-full"><svg qSpinner></svg></div>
    }
  `,
  host: { class: 'contents' },
})
export class MetabaseConnectionTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly metabase = inject(MetabaseActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ChartColumnBig, KeyRound, LogIn, LogOut, PlugZap, SquareTerminal, Trash2 };
  private readonly connectionId = computed(() => String(this.tab().data?.['id'] ?? ''));
  protected readonly summary = invokeResource<MetabaseConnectionSummary>('metabase.connection.get', () => ({ id: this.connectionId() }), {
    refreshOn: ['metabase-connections'],
    refreshOnEvents: ['metabase.changed'],
  });
  protected readonly where = computed(() => describeMetabaseConnection(this.summary.value() ?? { url: '', auth: 'browser' }));
  protected readonly dot = computed(() => {
    const c = this.summary.value();
    return c ? mbSessionDot(c.session) : '';
  });
  protected readonly sessionText = computed(() => {
    const c = this.summary.value();
    return c ? connectionSessionText(c) : '';
  });
  /** The key typed here; it is cleared once stored. */
  protected readonly apiKey = signal('');
  protected readonly savingKey = signal(false);
  protected readonly signingIn = signal(false);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  private readonly saving = signal(false);

  constructor() {
    // Ask the server once whether this machine gets in.
    let checked = false;
    effect(() => {
      const c = this.summary.value();
      if (checked || !c?.url) return;
      checked = true;
      untracked(() => void this.checkSession(c.id));
    });

    effect(() => {
      const name = this.summary.value()?.name;
      const tab = this.tab();
      if (name && tab.title !== name) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { title: name }));
    });
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected pickAuth(auth: string): void {
    const parsed = MetabaseAuthSchema.safeParse(auth);
    if (parsed.success) void this.save({ auth: parsed.data }).then(() => this.checkSession(this.connectionId()));
  }

  protected async save(patch: MetabaseConnectionDraft): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.testResult.set(null);
    try {
      await this.host.invoke<MetabaseConnectionSummary>('metabase.connection.save', { connection: { id: this.connectionId(), ...patch } });
      this.summary.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  protected async signIn(conn: MetabaseConnectionSummary): Promise<void> {
    this.signingIn.set(true);
    try {
      if (await this.metabase.signIn(conn)) await this.checkSession(conn.id);
    } finally {
      this.signingIn.set(false);
    }
  }

  protected async signOut(conn: MetabaseConnectionSummary): Promise<void> {
    await this.metabase.signOut(conn);
    this.testResult.set(null);
    await this.checkSession(conn.id);
  }

  protected async saveKey(conn: MetabaseConnectionSummary): Promise<void> {
    const apiKey = this.apiKey().trim();
    if (!apiKey || this.savingKey()) return;
    this.savingKey.set(true);
    try {
      await this.host.invoke<MetabaseConnectionSummary>('metabase.apikey.set', { connectionId: conn.id, apiKey });
      this.apiKey.set('');
      this.testResult.set(null);
      this.summary.reload();
      await this.checkSession(conn.id);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.savingKey.set(false);
    }
  }

  protected async clearKey(conn: MetabaseConnectionSummary): Promise<void> {
    try {
      await this.host.invoke<MetabaseConnectionSummary>('metabase.apikey.clear', { connectionId: conn.id });
      this.testResult.set(null);
      this.summary.reload();
      await this.checkSession(conn.id);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async test(conn: MetabaseConnectionSummary): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const r = await this.host.invoke<MetabaseTestResult>('metabase.connection.test', { connectionId: conn.id });
      const who = r.user.name || r.user.email;
      this.testResult.set({ ok: true, message: `Signed in as ${who}${r.version ? ` · Metabase ${r.version}` : ''}` });
    } catch (err) {
      this.testResult.set({ ok: false, message: toErrorPayload(err).message });
    } finally {
      this.testing.set(false);
    }
  }

  /** Ask the server whether this machine gets in; a change comes back as a session event, which reloads the summary. */
  private async checkSession(connectionId: string): Promise<void> {
    try {
      await this.host.invoke<MetabaseSession>('metabase.session', { connectionId });
    } catch {
      // The summary still says what it knows; the views that need the session show the failure.
    }
  }
}
