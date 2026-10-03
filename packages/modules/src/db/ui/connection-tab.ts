import { Component, computed, effect, inject, input, linkedSignal, resource, signal, untracked } from '@angular/core';
import { FormField, disabled, form } from '@angular/forms/signals';
import {
  DB_KIND_LABELS,
  DbKindSchema,
  defaultPort,
  newDbConnection,
  toErrorPayload,
  type DbAccess,
  type DbConnection,
  type DbConnectionSummary,
  type DbConnectionTest,
  type DbKind,
} from '@quiver/core';
import { AppState, Autofocus, Button, Checkbox, HostBridge, Input, Label, Select, Spinner, TabsState, Toasts, type Tab, type TabComponent } from '@quiver/ui';
import { FolderOpen, PlugZap, Save } from 'lucide';
import { KindIcon } from './kind-icon';
import { TeleportAccessFields, type TeleportAccess } from './teleport-access-fields';

type AccessType = DbAccess['type'];

const ACCESS_LABELS: Record<AccessType, string> = {
  direct: 'Direct',
  teleport: 'Teleport tunnel (tsh proxy db)',
  command: 'Command tunnel (ssh and similar)',
};

function defaultName(conn: DbConnection): string {
  if (conn.kind === 'sqlite') return `${DB_KIND_LABELS.sqlite} ${conn.file.split(/[\\/]/).pop() ?? ''}`.trim();
  if (conn.access.type === 'teleport') return conn.access.database || `${DB_KIND_LABELS[conn.kind]} via Teleport`;
  if (conn.access.type === 'command') return `${DB_KIND_LABELS[conn.kind]} tunnel`;
  return `${DB_KIND_LABELS[conn.kind]} ${conn.host}`;
}

function relativeToWorkspace(file: string, workspacePath: string): string {
  if (!workspacePath) return file;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file);
  const w = norm(workspacePath);
  const same = navigator.platform.startsWith('Win') ? f.toLowerCase().startsWith(`${w.toLowerCase()}/`) : f.startsWith(`${w}/`);
  return same ? f.slice(w.length + 1) : file;
}

/**
 * A MySQL, SQLite or Redis connection: where it is, how it is reached (directly, through a Teleport
 * tunnel or a tunnel command), and its credentials. The password is kept encrypted on this machine.
 */
@Component({
  selector: 'q-connection-tab',
  imports: [Autofocus, Button, Checkbox, FormField, Input, KindIcon, Label, Select, Spinner, TeleportAccessFields],
  templateUrl: './connection-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class ConnectionTab implements TabComponent {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { FolderOpen, PlugZap, Save };
  protected readonly kinds = DbKindSchema.options;
  protected readonly kindLabels = DB_KIND_LABELS;
  protected readonly accessTypes = Object.keys(ACCESS_LABELS) as AccessType[];
  protected readonly accessLabels = ACCESS_LABELS;
  private readonly tabKey = computed(() => String(this.tab().data?.['id'] ?? ''));
  /** A draft tab (`new-<kind>`) until the connection is first saved. */
  protected readonly isNew = computed(() => this.tabKey().startsWith('new-'));
  private readonly stored = resource({
    params: () => (this.isNew() ? undefined : { id: this.tabKey() }),
    loader: ({ params }) => this.host.invoke<DbConnectionSummary>('db.connection.get', params),
  });
  protected readonly loadError = computed(() => (this.stored.status() === 'error' ? toErrorPayload(this.stored.error()).message : null));
  protected readonly loaded = linkedSignal<boolean, boolean>({ source: () => this.isNew() || this.stored.hasValue(), computation: (ok, previous) => ok || (previous?.value ?? false) });
  private readonly saved = computed<DbConnection | null>(() => {
    if (!this.stored.hasValue()) return null;
    const { hasPassword: _hasPassword, ...conn } = this.stored.value();
    return conn;
  });
  /** What the fields edit: the stored connection, or a new one of the tab's kind. */
  protected readonly connection = linkedSignal<DbConnection | null, DbConnection>({
    source: () => (this.isNew() ? null : this.saved()),
    computation: (saved, previous) =>
      saved ?? previous?.value ?? newDbConnection(untracked(() => DbKindSchema.safeParse(this.tab().data?.['kind']).data ?? 'mysql'), { name: '' }),
  });
  protected readonly connectionForm = form(this.connection);
  protected readonly hasPassword = linkedSignal(() => (this.stored.hasValue() ? this.stored.value().hasPassword : false));
  /** The password typed here; it is sent when saving and never shown again. */
  protected readonly secret = signal({ password: '', clearPassword: false });
  protected readonly secretForm = form(this.secret, (p) => disabled(p.password, ({ valueOf }) => valueOf(p.clearPassword)));
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  protected readonly dirty = computed(() => {
    if (!this.loaded()) return false;
    if (this.isNew()) return true;
    const { password, clearPassword } = this.secret();
    return JSON.stringify(this.connection()) !== JSON.stringify(this.saved()) || password !== '' || clearPassword;
  });
  protected readonly teleportAccess = computed(() => {
    const access = this.connection().access;
    return access.type === 'teleport' ? access : null;
  });
  protected readonly commandAccess = computed(() => {
    const access = this.connection().access;
    return access.type === 'command' ? access : null;
  });
  protected readonly portPlaceholder = computed(() => String(defaultPort(this.connection().kind)));
  protected readonly passwordPlaceholder = computed(() => (this.hasPassword() && !this.secret().clearPassword ? '•••••••• (stored, leave blank to keep)' : 'optional'));
  protected readonly portSyntax = '{port}';

  constructor() {
    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected patch(patch: Partial<DbConnection>): void {
    this.connection.update((conn) => ({ ...conn, ...patch }));
  }

  protected switchKind(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value as DbKind;
    if (kind === this.connection().kind) return;
    this.patch({ kind, port: 0 });
    // A draft keeps its kind when the workspace is restored.
    if (this.isNew()) this.tabs.updateTab(this.scope(), this.tab().id, { data: { ...this.tab().data, kind } });
  }

  protected switchAccess(event: Event): void {
    const type = (event.target as HTMLSelectElement).value as AccessType;
    const conn = this.connection();
    if (type === conn.access.type) return;
    if (type === 'direct') this.patch({ access: { type: 'direct' } });
    else if (type === 'teleport') this.patch({ access: { type: 'teleport', proxy: '', database: '', dbUser: conn.user }, host: '127.0.0.1', port: 0, user: conn.kind === 'mysql' ? conn.user : '' });
    else this.patch({ access: { type: 'command', command: '' }, host: '127.0.0.1', port: 0 });
  }

  protected setTeleportAccess(access: TeleportAccess): void {
    this.patch({ access, user: this.connection().kind === 'mysql' ? access.dbUser : '' });
  }

  protected setCommand(event: Event): void {
    this.patch({ access: { type: 'command', command: (event.target as HTMLInputElement).value } });
  }

  protected setPort(event: Event): void {
    this.patch({ port: Number((event.target as HTMLInputElement).value) || 0 });
  }

  protected setDbIndex(event: Event): void {
    this.patch({ dbIndex: Math.max(0, Number((event.target as HTMLInputElement).value) || 0) });
  }

  protected async browseFile(): Promise<void> {
    const workspacePath = untracked(this.app.activeWorkspace)?.path ?? '';
    const { path } = await this.host.invoke<{ path: string | null }>(
      'app.pickFile',
      {
        title: 'Choose SQLite database',
        defaultPath: workspacePath || undefined,
        filters: [
          { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
          { name: 'All files', extensions: ['*'] },
        ],
      },
      null,
    );
    if (path) this.patch({ file: relativeToWorkspace(path, workspacePath) });
  }

  protected async save(): Promise<void> {
    const conn = this.connection();
    const { password, clearPassword } = this.secret();
    try {
      const name = conn.name.trim() || defaultName(conn);
      const stored = await this.host.invoke<DbConnectionSummary>('db.connection.save', {
        connection: { ...conn, name, ...(this.isNew() ? { id: undefined } : {}) },
        password: password || undefined,
        clearPassword: clearPassword || undefined,
      });
      this.stored.set(stored);
      const { hasPassword, ...saved } = stored;
      this.connection.set(saved);
      this.hasPassword.set(hasPassword);
      this.secret.set({ password: '', clearPassword: false });
      this.tabs.updateTab(this.scope(), this.tab().id, { title: saved.name, data: { id: saved.id } });
      this.toasts.notify('Connection saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async test(): Promise<void> {
    if (this.testing()) return;
    const conn = this.connection();
    const { password, clearPassword } = this.secret();
    this.testing.set(true);
    this.testResult.set(null);
    try {
      const result = await this.host.invoke<DbConnectionTest>('db.connection.test', {
        connection: this.isNew() ? { ...conn, id: undefined } : conn,
        password: password || (clearPassword ? '' : undefined),
      });
      this.testResult.set({ ok: true, message: `Connected to ${result.serverVersion} in ${result.latencyMs} ms` });
    } catch (err) {
      this.testResult.set({ ok: false, message: toErrorPayload(err).message });
    } finally {
      this.testing.set(false);
    }
  }
}
