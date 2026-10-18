import { Service, inject, untracked } from '@angular/core';
import {
  IMPORT_FORMATS,
  SHELL_DIALECT_LABELS,
  SHELL_DIALECTS,
  canMoveCollection,
  collectionPath,
  detectImportFormat,
  detectShellDialect,
  newId,
  nowIso,
  responseFromHistory,
  type ApiCollection,
  type ApiRequest,
  type Environment,
  type HistoryEntry,
  type ImportFormat,
} from '@quiver/core';
import { AppState, ContextMenu, Dialogs, HostBridge, TabsState, Toasts, TreeState, type ContextMenuItem } from '@quiver/ui';

/** What an `api.import.*` command reports. */
interface ImportSummary {
  collectionId: string | null;
  name: string | null;
  requests: number;
  environments: number;
  skipped: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the API client does from the sidebar, the palette and its tabs. */
@Service()
export class ApiActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly contextMenu = inject(ContextMenu);
  private readonly tree = inject(TreeState);

  openRequestTab(request: Pick<ApiRequest, 'id' | 'name'>, draft?: ApiRequest): void {
    this.tabs.openTab(
      untracked(this.app.scope),
      { type: 'api.request', title: request.name, data: draft ? { id: request.id, draft } : { id: request.id } },
      { singletonKey: `api.request:${request.id}` },
    );
  }

  /** The schema explorer of the endpoint a request points at. */
  openSchemaTab(request: Pick<ApiRequest, 'id' | 'name'>): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.graphql.schema', title: `Schema: ${request.name}`, data: { id: request.id } }, { singletonKey: `api.graphql.schema:${request.id}` });
  }

  openEnvironmentTab(env: Pick<Environment, 'id' | 'name'>): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.environment', title: `Env: ${env.name}`, data: { id: env.id } }, { singletonKey: `api.environment:${env.id}` });
  }

  async createRequest(collectionId: string | null = null): Promise<void> {
    const created = await this.host.invoke<ApiRequest>('api.request.create', { collectionId });
    this.openRequestTab(created);
  }

  async createGraphqlRequest(collectionId: string | null = null): Promise<void> {
    const created = await this.host.invoke<ApiRequest>('api.request.create', {
      name: 'New GraphQL request',
      method: 'POST',
      collectionId,
      body: { type: 'graphql', query: 'query {\n  \n}', variables: '' },
    });
    this.openRequestTab(created);
  }

  async importCurl(collectionId: string | null = null): Promise<void> {
    const result = await this.dialogs.promptWithChoice({
      title: 'Import from curl',
      label: 'Paste a curl command (Copy as cURL from bash, cmd or PowerShell)',
      multiline: true,
      confirmLabel: 'Import',
      choice: {
        label: 'Shell',
        defaultValue: 'auto',
        options: [{ value: 'auto', label: 'Detect' }, ...SHELL_DIALECTS.map((d) => ({ value: d, label: SHELL_DIALECT_LABELS[d] }))],
        hint: (text, choice) => (choice === 'auto' && text.trim() ? `Reads as ${SHELL_DIALECT_LABELS[detectShellDialect(text)]}` : null),
      },
    });
    if (!result?.value.trim()) return;
    try {
      const created = await this.host.invoke<ApiRequest>('api.import.curl', { command: result.value, collectionId, dialect: result.choice });
      this.openRequestTab(created);
      this.toasts.notify(`Imported ${created.name}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** The Import button: a curl command, a file in one of the formats, or a file's text pasted. */
  importMenu(event: MouseEvent, collectionId: string | null = null): void {
    this.contextMenu.open(event, [
      { label: 'From curl…', select: () => this.run(this.importCurl(collectionId)), testId: 'api-import-curl' },
      'separator',
      ...IMPORT_FORMATS.map((f) => ({ label: `From ${f.label}…`, select: () => this.run(this.importFile(f.value, collectionId)), testId: `api-import-${f.value}` })),
      'separator',
      { label: 'Paste a file…', select: () => this.run(this.importPasted(collectionId)), testId: 'api-import-paste' },
    ]);
  }

  /** Pick a file and import it; nothing happens when the picker is cancelled. */
  async importFile(format: ImportFormat, collectionId: string | null = null): Promise<void> {
    const f = IMPORT_FORMATS.find((x) => x.value === format)!;
    const workspacePath = untracked(this.app.activeWorkspace)?.path ?? '';
    const { path } = await this.host.invoke<{ path: string | null }>('app.pickFile', {
      title: `Import from ${f.label}`,
      filters: [
        { name: f.label, extensions: f.extensions },
        { name: 'All files', extensions: ['*'] },
      ],
      defaultPath: workspacePath || undefined,
    });
    if (path) await this.importSource(format, { path }, collectionId);
  }

  /** For a file that is easier to copy than to save: its text pasted, the format detected or picked. */
  async importPasted(collectionId: string | null = null): Promise<void> {
    const label = (format: ImportFormat | null) => IMPORT_FORMATS.find((f) => f.value === format)?.label;
    const result = await this.dialogs.promptWithChoice({
      title: 'Import',
      label: 'Paste an OpenAPI document, a Postman collection or environment, an Insomnia export or a HAR file (JSON or YAML)',
      multiline: true,
      confirmLabel: 'Import',
      choice: {
        label: 'Format',
        defaultValue: 'auto',
        options: [{ value: 'auto', label: 'Detect' }, ...IMPORT_FORMATS.map((f) => ({ value: f.value, label: f.label }))],
        hint: (text, choice) => {
          if (choice !== 'auto' || !text.trim()) return null;
          const detected = detectImportFormat(text);
          return detected ? `Reads as ${label(detected)}` : 'Not a format Quiver imports';
        },
      },
    });
    if (!result?.value.trim()) return;
    const format = result.choice === 'auto' ? detectImportFormat(result.value) : (result.choice as ImportFormat);
    if (!format) {
      this.toasts.notify('That is not an OpenAPI, Postman, Insomnia or HAR file', 'error');
      return;
    }
    await this.importSource(format, { text: result.value }, collectionId);
  }

  /** Import, then open what was created and say what was not imported. */
  private async importSource(format: ImportFormat, source: { path: string } | { text: string }, collectionId: string | null): Promise<void> {
    let summary: ImportSummary;
    try {
      summary = await this.host.invoke<ImportSummary>(`api.import.${format}`, { source, collectionId });
    } catch (err) {
      this.toasts.error(err);
      return;
    }
    if (collectionId) this.tree.expand(`api/collection/${collectionId}`);
    if (summary.collectionId) {
      this.tree.expand(`api/collection/${summary.collectionId}`);
      this.openCollectionTab({ id: summary.collectionId, name: summary.name ?? 'Imported' });
    }
    const parts = [summary.collectionId ? plural(summary.requests, 'request') : '', summary.environments ? plural(summary.environments, 'environment') : ''].filter(Boolean);
    const title = `Imported ${parts.join(' and ') || 'nothing'}${summary.name ? ` into ${summary.name}` : ''}`;
    if (!summary.skipped.length) {
      this.toasts.notify(title, 'success');
      return;
    }
    await this.dialogs.notice({ title, message: `Not imported:\n${summary.skipped.map((line) => `• ${line}`).join('\n')}` });
  }

  async createEnvironment(): Promise<void> {
    const name = await this.dialogs.prompt({ title: 'New environment', label: 'Name', placeholder: 'e.g. staging', confirmLabel: 'Create' });
    if (!name?.trim()) return;
    const env = await this.host.invoke<Environment>('api.environment.create', { name: name.trim() });
    this.openEnvironmentTab(env);
  }

  async deleteEnvironment(env: Environment): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete environment "${env.name}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    await this.host.invoke('api.environment.delete', { id: env.id });
    this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'api.environment' && t.data?.['id'] === env.id);
  }

  async clearHistory(): Promise<void> {
    if (await this.dialogs.confirm({ title: 'Clear request history?', danger: true, confirmLabel: 'Clear' })) await this.host.invoke('api.history.clear');
  }

  async newCollection(parentId: string | null): Promise<void> {
    const name = await this.dialogs.prompt({ title: 'New collection', label: 'Name', confirmLabel: 'Create' });
    if (name?.trim()) await this.host.invoke('api.collection.create', { name: name.trim(), parentId });
  }

  async renameRequest(request: ApiRequest): Promise<void> {
    const name = await this.dialogs.prompt({ title: 'Rename request', defaultValue: request.name, confirmLabel: 'Rename' });
    if (name?.trim() && name !== request.name) await this.host.invoke('api.request.save', { request: { ...request, name: name.trim() } });
  }

  async duplicateRequest(request: ApiRequest): Promise<void> {
    await this.host.invoke('api.request.duplicate', { id: request.id });
  }

  async deleteRequest(request: ApiRequest): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${request.name}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    await this.host.invoke('api.request.delete', { id: request.id });
    this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'api.request' && t.data?.['id'] === request.id);
  }

  async renameCollection(collection: ApiCollection): Promise<void> {
    const name = await this.dialogs.prompt({ title: 'Rename collection', defaultValue: collection.name, confirmLabel: 'Rename' });
    if (name?.trim() && name !== collection.name) await this.host.invoke('api.collection.rename', { id: collection.id, name: name.trim() });
  }

  async deleteCollection(collection: ApiCollection): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete "${collection.name}" and everything inside?`, danger: true, confirmLabel: 'Delete' }))) return;
    await this.host.invoke('api.collection.delete', { id: collection.id });
  }

  /** What a collection passes on to its requests: base URL, headers, auth, notes. */
  openCollectionTab(collection: Pick<ApiCollection, 'id' | 'name'>): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.collection', title: collection.name, data: { id: collection.id } }, { singletonKey: `api.collection:${collection.id}` });
  }

  /**
   * Pick a file for a request body: the path relative to the project folder when the file is inside
   * it, so the committed request works for everyone, else absolute. Null when cancelled.
   */
  async pickRequestFile(title: string): Promise<string | null> {
    const workspacePath = untracked(this.app.activeWorkspace)?.path ?? '';
    const { path } = await this.host.invoke<{ path: string | null }>('app.pickFile', { title, defaultPath: workspacePath || undefined });
    if (!path) return null;
    const info = await this.host.invoke<{ relative: string | null }>('api.file.stat', { path });
    return info.relative ?? path;
  }

  /** Start a run of the collection and show it in its run tab (one per collection, showing the latest run). */
  async runCollection(collection: Pick<ApiCollection, 'id' | 'name'>, options: { stopOnFail?: boolean } = {}): Promise<void> {
    const { runId } = await this.host.invoke<{ runId: string }>('api.collection.run', { collectionId: collection.id, ...options });
    this.openRunTab(collection, runId);
  }

  openRunTab(collection: Pick<ApiCollection, 'id' | 'name'>, runId?: string): void {
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'api.run', title: `Run: ${collection.name}`, data: { collectionId: collection.id } }, { singletonKey: `api.run:${collection.id}` });
    if (runId) this.tabs.updateTab(scope, tab.id, { data: { collectionId: collection.id, runId } });
  }

  /** The workspace's client certificates. */
  openCertificates(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.certificates', title: 'Client certificates', data: {} }, { singletonKey: 'api.certificates' });
  }

  /** The workspace's cookie jar. */
  openCookieJar(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.cookies', title: 'Cookie jar', data: {} }, { singletonKey: 'api.cookies' });
  }

  /** The full request history in a tab of its own. */
  openHistoryTab(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.history', title: 'Request history', data: {} }, { singletonKey: 'api.history' });
  }

  /** A past request opens as an unsaved draft, with the credentials that were typed into it still masked. */
  openHistoryEntry(entry: HistoryEntry): void {
    const id = `history-${entry.id}`;
    this.openRequestTab({ id, name: entry.request.name }, { ...entry.request, id });
  }

  /** A past send with its kept response: the request as a draft, the response in the pane. */
  async openHistoryResponse(entry: Pick<HistoryEntry, 'id'>): Promise<void> {
    const full = await this.host.invoke<HistoryEntry>('api.history.get', { id: entry.id });
    const id = `history-${full.id}`;
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'api.request', title: full.request.name, data: { id, draft: { ...full.request, id } } }, { singletonKey: `api.request:${id}` });
    this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, response: responseFromHistory(full) } });
  }

  /** Kept responses of a saved request side by side: the newest two, or the given ones. */
  openDiff(request: { id: string; name: string }, right?: string, left?: string): void {
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'api.diff', title: `Compare: ${request.name}`, data: { requestId: request.id } }, { singletonKey: `api.diff:${request.id}` });
    this.tabs.updateTab(scope, tab.id, { data: { requestId: request.id, ...(right ? { right } : {}), ...(left ? { left } : {}) } });
  }

  /** Keeps a past request as a new saved request, at the root, masks and all. */
  async saveHistoryEntry(entry: HistoryEntry): Promise<void> {
    const ts = nowIso();
    const saved = await this.host.invoke<ApiRequest>('api.request.save', { request: { ...entry.request, id: newId(), collectionId: null, createdAt: ts, updatedAt: ts } });
    this.openRequestTab(saved);
    this.toasts.notify(`Saved ${saved.name} from the history`, 'success');
  }

  async copyCurl(request: ApiRequest): Promise<void> {
    const { command } = await this.host.invoke<{ command: string }>('api.export.curl', { requestId: request.id });
    await navigator.clipboard.writeText(command);
    this.toasts.notify('Copied curl command', 'success');
  }

  async moveRequest(request: Pick<ApiRequest, 'id' | 'name'>, collectionId: string | null): Promise<void> {
    await this.host.invoke('api.request.move', { id: request.id, collectionId });
    if (collectionId) this.tree.expand(`api/collection/${collectionId}`);
  }

  async moveCollection(collection: Pick<ApiCollection, 'id'>, parentId: string | null): Promise<void> {
    await this.host.invoke('api.collection.move', { id: collection.id, parentId });
    if (parentId) this.tree.expand(`api/collection/${parentId}`);
  }

  /** Right-click, or the row's … button, on a request. */
  requestMenu(event: MouseEvent, request: ApiRequest): void {
    const at = { x: event.clientX, y: event.clientY };
    this.contextMenu.open(event, [
      { label: 'Open', select: () => this.openRequestTab(request), testId: 'api-menu-open' },
      { label: 'Rename…', select: () => this.run(this.renameRequest(request)), testId: 'api-menu-rename' },
      { label: 'Duplicate', select: () => this.run(this.duplicateRequest(request)) },
      { label: 'Copy as curl', select: () => this.run(this.copyCurl(request)) },
      { label: 'Move to…', select: () => this.run(this.moveMenu(at, request.collectionId ?? null, (target) => this.moveRequest(request, target))), testId: 'api-menu-move' },
      'separator',
      { label: 'Delete', danger: true, select: () => this.run(this.deleteRequest(request)) },
    ]);
  }

  /** Right-click, or the row's … button, on a collection. */
  collectionMenu(event: MouseEvent, collection: ApiCollection): void {
    const at = { x: event.clientX, y: event.clientY };
    this.contextMenu.open(event, [
      { label: 'Settings…', select: () => this.openCollectionTab(collection), testId: 'api-menu-collection-settings' },
      { label: 'Run collection', select: () => this.run(this.runCollection(collection)), testId: 'api-menu-collection-run' },
      'separator',
      { label: 'New request', select: () => this.run(this.createRequest(collection.id)) },
      { label: 'New GraphQL request', select: () => this.run(this.createGraphqlRequest(collection.id)) },
      { label: 'New sub-collection…', select: () => this.run(this.newCollection(collection.id)) },
      { label: 'Import here…', select: () => this.run(Promise.resolve().then(() => this.importMenu(new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y }), collection.id))), testId: 'api-menu-import-here' },
      'separator',
      { label: 'Rename…', select: () => this.run(this.renameCollection(collection)) },
      {
        label: 'Move to…',
        select: () => this.run(this.moveMenu(at, collection.parentId ?? null, (target) => this.moveCollection(collection, target), collection.id)),
      },
      'separator',
      { label: 'Delete', danger: true, select: () => this.run(this.deleteCollection(collection)) },
    ]);
  }

  /** A second menu of where to move to: the root, then every collection by path, the current place disabled. */
  private async moveMenu(at: { x: number; y: number }, current: string | null, move: (target: string | null) => Promise<void>, movingCollection?: string): Promise<void> {
    const collections = await this.host.invoke<ApiCollection[]>('api.collection.list', {});
    const choices = collections
      .filter((c) => !movingCollection || canMoveCollection(collections, movingCollection, c.id))
      .map((c) => ({ id: c.id, path: collectionPath(collections, c.id) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const items: ContextMenuItem[] = [
      { label: 'Top level', disabled: current === null, select: () => this.run(move(null)), testId: 'api-move-root' },
      ...(choices.length ? (['separator'] as const) : []),
      ...choices.map((c) => ({ label: c.path, disabled: c.id === current, select: () => this.run(move(c.id)), testId: `api-move-${c.id}` })),
    ];
    this.contextMenu.open(new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y }), items);
  }

  private run(action: Promise<unknown>): void {
    action.catch((err) => this.toasts.error(err));
  }

  async setActiveEnvironment(id: string | null): Promise<void> {
    await this.host.invoke('api.environment.setActive', { id });
  }
}
