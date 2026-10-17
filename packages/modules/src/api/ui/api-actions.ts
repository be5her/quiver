import { Service, inject, untracked } from '@angular/core';
import {
  SHELL_DIALECT_LABELS,
  SHELL_DIALECTS,
  canMoveCollection,
  collectionPath,
  detectShellDialect,
  newId,
  nowIso,
  type ApiCollection,
  type ApiRequest,
  type Environment,
  type HistoryEntry,
} from '@quiver/core';
import { AppState, ContextMenu, Dialogs, HostBridge, TabsState, Toasts, TreeState, type ContextMenuItem } from '@quiver/ui';

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

  /** The full request history in a tab of its own. */
  openHistoryTab(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'api.history', title: 'Request history', data: {} }, { singletonKey: 'api.history' });
  }

  /** A past request opens as an unsaved draft, with the credentials that were typed into it still masked. */
  openHistoryEntry(entry: HistoryEntry): void {
    const id = `history-${entry.id}`;
    this.openRequestTab({ id, name: entry.request.name }, { ...entry.request, id });
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
      { label: 'New request', select: () => this.run(this.createRequest(collection.id)) },
      { label: 'New GraphQL request', select: () => this.run(this.createGraphqlRequest(collection.id)) },
      { label: 'New sub-collection…', select: () => this.run(this.newCollection(collection.id)) },
      { label: 'Import from curl here…', select: () => this.run(this.importCurl(collection.id)) },
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
