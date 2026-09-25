import { defineModuleUI, invoke, notify, promptDialog, selectScope, useAppStore, useTabsStore } from '@quiver/ui';
import type { ApiRequest, Environment } from '@quiver/core';
import { Globe } from 'lucide-react';
import { EnvironmentTab } from './EnvironmentTab';
import { RequestTab } from './RequestTab';
import { SchemaTab } from './SchemaTab';
import { ApiSidebar } from './Sidebar';

export function openRequestTab(request: Pick<ApiRequest, 'id' | 'name'>, draft?: ApiRequest): void {
  const scope = selectScope(useAppStore.getState());
  useTabsStore
    .getState()
    .openTab(scope, { type: 'api.request', title: request.name, data: draft ? { id: request.id, draft } : { id: request.id } }, { singletonKey: `api.request:${request.id}` });
}

/** The schema explorer of the endpoint a request points at. */
export function openSchemaTab(request: Pick<ApiRequest, 'id' | 'name'>): void {
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().openTab(scope, { type: 'api.graphql.schema', title: `Schema: ${request.name}`, data: { id: request.id } }, { singletonKey: `api.graphql.schema:${request.id}` });
}

export function openEnvironmentTab(env: Pick<Environment, 'id' | 'name'>): void {
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().openTab(scope, { type: 'api.environment', title: `Env: ${env.name}`, data: { id: env.id } }, { singletonKey: `api.environment:${env.id}` });
}

const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

export async function createRequest(collectionId: string | null = null): Promise<void> {
  const created = await invoke<ApiRequest>('api.request.create', { collectionId });
  openRequestTab(created);
}

export async function createGraphqlRequest(collectionId: string | null = null): Promise<void> {
  const created = await invoke<ApiRequest>('api.request.create', {
    name: 'New GraphQL request',
    method: 'POST',
    collectionId,
    body: { type: 'graphql', query: 'query {\n  \n}', variables: '' },
  });
  openRequestTab(created);
}

export async function importCurl(collectionId: string | null = null): Promise<void> {
  const command = await promptDialog({ title: 'Import from curl', label: 'Paste a curl command', multiline: true, confirmLabel: 'Import' });
  if (!command?.trim()) return;
  try {
    const created = await invoke<ApiRequest>('api.import.curl', { command, collectionId });
    openRequestTab(created);
    notify(`Imported ${created.name}`, 'success');
  } catch (err) {
    notify((err as Error).message, 'error');
  }
}

export async function createEnvironment(): Promise<void> {
  const name = await promptDialog({ title: 'New environment', label: 'Name', placeholder: 'e.g. staging', confirmLabel: 'Create' });
  if (!name?.trim()) return;
  const env = await invoke<Environment>('api.environment.create', { name: name.trim() });
  openEnvironmentTab(env);
}

export const apiModuleUI = defineModuleUI({
  id: 'api',
  title: 'API client',
  icon: Globe,
  order: 10,
  availability: 'workspace',
  Sidebar: ApiSidebar,
  tabs: {
    'api.request': RequestTab,
    'api.environment': EnvironmentTab,
    'api.graphql.schema': SchemaTab,
  },
  actions: [
    { id: 'api.request.new', title: 'New API request', group: 'API', shortcut: 'Ctrl+N', run: () => createRequest(), when: hasWorkspace },
    { id: 'api.request.newGraphql', title: 'New GraphQL request', group: 'API', run: () => createGraphqlRequest(), when: hasWorkspace },
    { id: 'api.import.curl', title: 'Import request from curl', group: 'API', run: () => importCurl(), when: hasWorkspace },
    { id: 'api.environment.new', title: 'New environment', group: 'API', run: () => createEnvironment(), when: hasWorkspace },
  ],
});
