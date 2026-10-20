import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { QueueKindSchema, toErrorPayload, type QueueConnection } from '@quiver/core';
import { Button, Checkbox, HostBridge, Icon, Input, Label, Segment, Segmented, Select, Spinner, TabsState, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Layers, PlugZap, Plus, Save, Trash2 } from 'lucide';
import { QueuesGroupLag } from './group-lag';
import { QueuesActions } from './queues-actions';
import { injectQueuesChanged } from './queues-events';
import { KIND_LABEL, QUEUE_KINDS, describeQueueConnection, destinationWord, secretNameOf, type QueueConnectionSummary } from './queues-format';

/** What the fields edit: the connection's settings as text, so every field binds to a plain input. */
interface ConnectionDraft {
  name: string;
  kind: QueueConnection['kind'];
  brokers: string;
  clientId: string;
  ssl: boolean;
  sasl: QueueConnection['sasl'];
  username: string;
  region: string;
  profile: string;
  accessKeyId: string;
  endpoint: string;
  host: string;
  port: string;
  vhost: string;
  managementUrl: string;
}

function draftOf(c: QueueConnection): ConnectionDraft {
  return {
    name: c.name,
    kind: c.kind,
    brokers: c.brokers.join(', '),
    clientId: c.clientId,
    ssl: c.ssl,
    sasl: c.sasl,
    username: c.username,
    region: c.region,
    profile: c.profile,
    accessKeyId: c.accessKeyId,
    endpoint: c.endpoint,
    host: c.host,
    port: c.port === undefined ? '' : String(c.port),
    vhost: c.vhost,
    managementUrl: c.managementUrl,
  };
}

/** The draft as `queues.connection.save` takes it. An empty port is `null`, which removes a stored one. */
function connectionOf(d: ConnectionDraft): Record<string, unknown> {
  const typed = d.port.trim();
  const port = typed === '' ? null : Number(typed);
  return {
    name: d.name,
    kind: d.kind,
    brokers: d.brokers
      .split(/[\s,]+/)
      .map((b) => b.trim())
      .filter(Boolean),
    clientId: d.clientId,
    ssl: d.ssl,
    sasl: d.sasl,
    username: d.username,
    region: d.region,
    profile: d.profile,
    accessKeyId: d.accessKeyId,
    endpoint: d.endpoint.trim(),
    host: d.host.trim(),
    port,
    vhost: d.vhost,
    managementUrl: d.managementUrl.trim(),
  };
}

/** Why the typed port cannot be saved, or null when it is empty (the default) or a valid port. */
function portProblem(d: ConnectionDraft): string | null {
  const typed = d.port.trim();
  if (typed === '') return null;
  const n = Number(typed);
  return /^\d+$/.test(typed) && n >= 1 && n <= 65535 ? null : 'The port must be a number from 1 to 65535, or empty for the default';
}

const EMPTY: ConnectionDraft = draftOf({
  id: '',
  name: '',
  kind: 'memory',
  brokers: [],
  clientId: 'quiver',
  ssl: false,
  sasl: 'none',
  username: '',
  region: '',
  profile: '',
  accessKeyId: '',
  endpoint: '',
  host: '',
  vhost: '/',
  managementUrl: '',
});

type View = 'settings' | 'groups';

/**
 * A queue connection: the broker's fields for its kind, the password or secret key (sent once, kept
 * encrypted on this machine and never shown again), a test, and for Kafka the consumer groups. Ctrl+S saves.
 */
@Component({
  selector: 'q-queues-connection-tab',
  imports: [Button, Checkbox, FormField, Icon, Input, Label, QueuesGroupLag, Segment, Segmented, Select, Spinner],
  template: `
    @if (summary.error(); as error) {
      <div class="p-4 text-sm text-danger">{{ error.message }}</div>
    } @else if (summary.value(); as c) {
      @let d = draft();
      <div class="flex flex-col h-full min-h-0 w-full" data-testid="queues-connection-tab" [attr.data-kind]="d.kind">
        <div class="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
          <svg [qIcon]="icons.Layers" class="size-4 text-accent shrink-0"></svg>
          <span class="font-medium text-sm shrink-0 truncate max-w-64">{{ c.name }}</span>
          <span class="text-xs text-muted truncate min-w-0">{{ where() }}</span>
          <span class="flex-1 min-w-4"></span>
          <button qButton size="sm" variant="ghost" [icon]="icons.Plus" [disabled]="dirty()" data-testid="queues-tab-new-destination" (click)="actions.createDestination(c)">New {{ word() }}</button>
          <button qButton size="sm" variant="ghost" [icon]="icons.PlugZap" [loading]="testing()" data-testid="queues-test" (click)="test()">Test</button>
          <button qButton size="sm" [variant]="dirty() ? 'primary' : 'ghost'" [icon]="icons.Save" title="Ctrl+S" data-testid="queues-save" (click)="save()">Save{{ dirty() ? '*' : '' }}</button>
        </div>
        @if (d.kind === 'kafka') {
          <q-segmented [(value)]="view" class="shrink-0 px-1">
            <button qSegment="settings">Settings</button>
            <button qSegment="groups" data-testid="queues-view-groups">Consumer groups</button>
          </q-segmented>
        }
        @if (view() === 'groups' && d.kind === 'kafka') {
          <div class="flex-1 min-h-0"><q-queues-group-lag [connectionId]="c.id" /></div>
        } @else {
          <div class="flex-1 min-h-0 overflow-y-auto">
            <div class="max-w-xl flex flex-col gap-4 p-4">
              <div class="grid grid-cols-[1fr_180px] gap-2">
                <div>
                  <label qLabel for="queues-name">Name</label>
                  <input qInput id="queues-name" [formField]="connectionForm.name" data-testid="queues-name" />
                </div>
                <div>
                  <label qLabel for="queues-kind">Broker</label>
                  <select qSelect id="queues-kind" data-testid="queues-kind" (change)="pickKind($event)">
                    @for (k of kinds; track k) {
                      <option [value]="k" [selected]="k === d.kind">{{ kindLabel[k] }}</option>
                    }
                  </select>
                </div>
              </div>

              @switch (d.kind) {
                @case ('memory') {
                  <p class="text-xs text-muted" data-testid="queues-memory-note">
                    Topics with partitions and offsets like Kafka, kept in Quiver until the connection is deleted, the workspace closes or Quiver quits. The first message to a name creates the topic. Good for trying the panel and for tests; nothing to set up.
                  </p>
                }
                @case ('kafka') {
                  <div>
                    <label qLabel for="queues-brokers">Bootstrap brokers</label>
                    <input qInput id="queues-brokers" class="font-mono" placeholder="localhost:9092, broker-2:9092" [formField]="connectionForm.brokers" data-testid="queues-brokers" />
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label qLabel for="queues-client">Client id</label>
                      <input qInput id="queues-client" class="font-mono" [formField]="connectionForm.clientId" />
                    </div>
                    <div>
                      <label qLabel for="queues-sasl">SASL</label>
                      <select qSelect id="queues-sasl" [formField]="connectionForm.sasl" data-testid="queues-sasl">
                        <option value="none">None</option>
                        <option value="plain">PLAIN</option>
                        <option value="scram-sha-256">SCRAM-SHA-256</option>
                        <option value="scram-sha-512">SCRAM-SHA-512</option>
                      </select>
                    </div>
                  </div>
                  <label class="flex items-center gap-2 text-sm"><input type="checkbox" qCheckbox [formField]="connectionForm.ssl" /> TLS</label>
                  @if (d.sasl !== 'none') {
                    <div>
                      <label qLabel for="queues-username">Username</label>
                      <input qInput id="queues-username" class="font-mono" [formField]="connectionForm.username" />
                    </div>
                  }
                }
                @case ('sqs') {
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label qLabel for="queues-region">Region</label>
                      <input qInput id="queues-region" class="font-mono" placeholder="eu-west-1" [formField]="connectionForm.region" data-testid="queues-region" />
                    </div>
                    <div>
                      <label qLabel for="queues-profile">AWS profile</label>
                      <input qInput id="queues-profile" class="font-mono" placeholder="default (or use an access key)" [formField]="connectionForm.profile" />
                    </div>
                  </div>
                  <div>
                    <label qLabel for="queues-access-key">Access key id</label>
                    <input qInput id="queues-access-key" class="font-mono" placeholder="AKIA… (leave empty to use the profile)" [formField]="connectionForm.accessKeyId" />
                  </div>
                  <div>
                    <label qLabel for="queues-endpoint">Endpoint</label>
                    <input qInput id="queues-endpoint" class="font-mono" placeholder="http://localhost:4566 for LocalStack; empty for AWS" [formField]="connectionForm.endpoint" />
                  </div>
                }
                @case ('rabbit') {
                  <div class="grid grid-cols-[1fr_100px_100px] gap-2">
                    <div>
                      <label qLabel for="queues-host">Host</label>
                      <input qInput id="queues-host" class="font-mono" placeholder="localhost" [formField]="connectionForm.host" data-testid="queues-host" />
                    </div>
                    <div>
                      <label qLabel for="queues-port">Port</label>
                      <input qInput id="queues-port" class="font-mono" inputmode="numeric" [placeholder]="d.ssl ? '5671' : '5672'" [formField]="connectionForm.port" />
                    </div>
                    <div>
                      <label qLabel for="queues-vhost">Virtual host</label>
                      <input qInput id="queues-vhost" class="font-mono" [formField]="connectionForm.vhost" />
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <label qLabel for="queues-username">Username</label>
                      <input qInput id="queues-username" class="font-mono" placeholder="guest" [formField]="connectionForm.username" />
                    </div>
                    <label class="flex items-center gap-2 text-sm self-end h-8"><input type="checkbox" qCheckbox [formField]="connectionForm.ssl" /> TLS (amqps)</label>
                  </div>
                  <div>
                    <label qLabel for="queues-management">Management API</label>
                    <input qInput id="queues-management" class="font-mono" placeholder="http://localhost:15672" [formField]="connectionForm.managementUrl" />
                    <p class="text-[11px] text-muted mt-1">Lists queues with their counts, with the same user. Never put the user or password in a URL: they would be committed.</p>
                  </div>
                }
              }

              @if (secretName(); as name) {
                @if (secretVisible()) {
                  <div>
                    <label qLabel for="queues-secret">{{ name === 'secretAccessKey' ? 'Secret access key' : 'Password' }}</label>
                    <input
                      qInput
                      id="queues-secret"
                      type="password"
                      class="font-mono"
                      autocomplete="off"
                      [placeholder]="secretPlaceholder()"
                      [disabled]="secret().clear"
                      [value]="secret().value"
                      (input)="typeSecret($event)"
                      data-testid="queues-secret"
                    />
                    <div class="flex items-center gap-2 mt-1 min-h-7">
                      <span class="text-[11px]" [class]="hasSecret() && !secret().clear ? 'text-success' : 'text-muted'" data-testid="queues-secret-state">{{ secretState() }}</span>
                      @if (hasSecret()) {
                        <label class="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" qCheckbox [checked]="secret().clear" (change)="clearSecret($event)" data-testid="queues-secret-clear" /> Remove on save</label>
                      }
                    </div>
                  </div>
                }
              }
              @if (unused().length) {
                <div class="flex items-center gap-2 text-[11px] text-muted min-h-7" data-testid="queues-secret-unused">
                  <span>Also stored on this machine, not used by these settings: {{ unused().join(', ') }}</span>
                  <label class="flex items-center gap-1"><input type="checkbox" qCheckbox [checked]="removeUnused()" (change)="pickRemoveUnused($event)" /> Remove on save</label>
                </div>
              }

              @if (testResult(); as r) {
                <p class="text-xs" [class]="r.ok ? 'text-success' : 'text-danger'" data-testid="queues-test-result" [attr.data-ok]="r.ok">{{ r.message }}</p>
              }

              <p class="text-[11px] text-muted">The project file holds the broker's address and user only. Passwords and keys are kept encrypted on this machine, never committed and never shown again, so teammates use their own.</p>

              <div class="flex items-center gap-2 pt-2 border-t border-edge">
                <span class="flex-1"></span>
                <button qButton size="sm" variant="danger" [icon]="icons.Trash2" data-testid="queues-delete-connection" (click)="actions.deleteConnection(c)">Delete connection</button>
              </div>
            </div>
          </div>
        }
      </div>
    } @else {
      <div class="flex items-center justify-center h-full w-full"><svg qSpinner></svg></div>
    }
  `,
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class QueuesConnectionTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly actions = inject(QueuesActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Layers, PlugZap, Plus, Save, Trash2 };
  protected readonly kinds = QUEUE_KINDS;
  protected readonly kindLabel = KIND_LABEL;
  private readonly connectionId = computed(() => String(this.tab().data?.['id'] ?? ''));
  /** The file is announced by the store; secrets changing (or the connection going) by `queues.changed{connections}`. */
  protected readonly summary = invokeResource<QueueConnectionSummary>('queues.connection.get', () => ({ id: this.connectionId() }), { refreshOn: ['queues'] });
  private readonly saved = computed(() => {
    const c = this.summary.value();
    return c ? draftOf(c) : undefined;
  });
  /** What the fields edit. A change made elsewhere (MCP, another window) replaces it while it has no unsaved edits. */
  protected readonly draft = linkedSignal<ConnectionDraft | undefined, ConnectionDraft>({
    source: this.saved,
    computation: (saved, previous) => {
      if (!previous?.source) return saved ?? previous?.value ?? EMPTY;
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !saved ? previous.value : saved;
    },
  });
  protected readonly connectionForm = form(this.draft);
  /** The secret typed here: sent with the next save, then cleared; the stored one is never read back. */
  protected readonly secret = signal({ value: '', clear: false });
  /** Whether stored secrets these settings do not use go with the next save. */
  protected readonly removeUnused = signal(false);
  protected readonly view = signal<View>('settings');
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  private readonly saving = signal(false);

  /** The settings on screen as one value, so a reload that brings the same settings back changes nothing. */
  private readonly settingsKey = computed(() => JSON.stringify([this.draft(), this.typedSecret()]));
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    const s = this.typedSecret();
    return Boolean(saved && (JSON.stringify(this.draft()) !== JSON.stringify(saved) || s.value !== '' || s.clear || (this.removeUnused() && this.unused().length > 0)));
  });
  protected readonly where = computed(() => {
    const c = this.summary.value();
    return c ? describeQueueConnection(c) : '';
  });
  protected readonly word = computed(() => destinationWord(this.draft().kind));
  protected readonly secretName = computed(() => secretNameOf(this.draft().kind));
  /** The secret box shows where the settings use it: not on the memory broker, nor on Kafka without SASL. */
  protected readonly secretVisible = computed(() => {
    const d = this.draft();
    return this.secretName() !== null && (d.kind !== 'kafka' || d.sasl !== 'none');
  });
  /** What was typed or ticked in the box, counted only while the box shows, so a hidden box sends nothing. */
  private readonly typedSecret = computed(() => (this.secretVisible() ? this.secret() : { value: '', clear: false }));
  /** Secrets stored for this connection that these settings do not use (another broker's, or Kafka without SASL). */
  protected readonly unused = computed(() => {
    const used = this.secretVisible() ? this.secretName() : null;
    return (this.summary.value()?.secrets ?? []).filter((n) => n !== used);
  });
  protected readonly hasSecret = computed(() => {
    const name = this.secretName();
    return Boolean(name && this.summary.value()?.secrets.includes(name));
  });
  protected readonly secretPlaceholder = computed(() => (this.hasSecret() && !this.secret().clear ? '•••••••• (stored, leave blank to keep)' : 'not set'));
  protected readonly secretState = computed(() => {
    if (this.secret().clear) return 'Removed when you save';
    if (this.secret().value) return 'Stored encrypted on this machine when you save';
    return this.hasSecret() ? 'Stored on this machine' : 'Nothing stored on this machine';
  });

  constructor() {
    injectQueuesChanged((p) => {
      if (p.reason === 'connections' && p.connectionId === this.connectionId()) this.summary.reload();
    });
    // A test result is about the settings it was run with.
    effect(() => {
      this.settingsKey();
      untracked(() => this.testResult.set(null));
    });
    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
    effect(() => {
      const name = this.summary.value()?.name;
      const tab = this.tab();
      if (name && tab.title !== name) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { title: name }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected pickKind(event: Event): void {
    const parsed = QueueKindSchema.safeParse((event.target as HTMLSelectElement).value);
    if (parsed.success) this.draft.update((d) => ({ ...d, kind: parsed.data }));
  }

  protected typeSecret(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.secret.update((s) => ({ ...s, value }));
  }

  protected clearSecret(event: Event): void {
    const clear = (event.target as HTMLInputElement).checked;
    this.secret.set({ value: '', clear });
  }

  protected pickRemoveUnused(event: Event): void {
    this.removeUnused.set((event.target as HTMLInputElement).checked);
  }

  /** The change to the box's secret, by name: the typed value, null to remove it, or nothing (also while it is hidden). */
  private typedSecretChange(): Record<string, string | null> {
    const name = this.secretName();
    const { value, clear } = this.typedSecret();
    if (!name || !this.secretVisible()) return {};
    if (clear) return { [name]: null };
    return value ? { [name]: value } : {};
  }

  /** What a save sends: the box's change, and the unused secrets when they are to go. */
  private secretChanges(): Record<string, string | null> | undefined {
    const changes: Record<string, string | null> = { ...this.typedSecretChange() };
    if (this.removeUnused()) for (const name of this.unused()) changes[name] = null;
    return Object.keys(changes).length ? changes : undefined;
  }

  protected async save(): Promise<void> {
    if (this.saving() || !this.dirty()) return;
    const problem = portProblem(this.draft());
    if (problem) {
      this.toasts.notify(problem, 'error');
      return;
    }
    this.saving.set(true);
    this.testResult.set(null);
    try {
      const secrets = this.secretChanges();
      const stored = await this.host.invoke<QueueConnectionSummary>('queues.connection.save', { connection: { id: this.connectionId(), ...connectionOf(this.draft()) }, ...(secrets ? { secrets } : {}) });
      this.secret.set({ value: '', clear: false });
      this.removeUnused.set(false);
      this.draft.set(draftOf(stored));
      this.summary.reload();
      this.toasts.notify('Saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  /** Test what is on screen: the saved connection, or the unsaved changes on top of it with a newly typed secret. */
  protected async test(): Promise<void> {
    const problem = portProblem(this.draft());
    if (problem) {
      this.testResult.set({ ok: false, message: problem });
      return;
    }
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const typed = this.typedSecretChange();
      const secrets = Object.keys(typed).length ? typed : undefined;
      const changed = JSON.stringify(this.draft()) !== JSON.stringify(this.saved());
      const r = await this.host.invoke<{ ok: boolean; message: string }>('queues.connection.test', {
        id: this.connectionId(),
        ...(changed ? { connection: connectionOf(this.draft()) } : {}),
        ...(secrets ? { secrets } : {}),
      });
      this.testResult.set(r);
    } catch (err) {
      this.testResult.set({ ok: false, message: toErrorPayload(err).message });
    } finally {
      this.testing.set(false);
    }
  }
}
