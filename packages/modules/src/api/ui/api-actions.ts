import { Service, inject, untracked } from '@angular/core';
import { SHELL_DIALECT_LABELS, SHELL_DIALECTS, detectShellDialect, type ApiCollection, type ApiRequest, type Environment } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';

/** What the API client does from the sidebar, the palette and its tabs. */
@Service()
export class ApiActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

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

  async setActiveEnvironment(id: string | null): Promise<void> {
    await this.host.invoke('api.environment.setActive', { id });
  }
}
