import { toErrorPayload, type EnvFileSummary, type Environment } from '@quiver/core';
import { confirmDialog, defineModuleUI, invoke, notify, promptDialog, selectScope, useAppStore, useTabsStore } from '@quiver/ui';
import { FileKey } from 'lucide-react';
import { openEnvironmentTab } from '../../api/ui';
import { FileTab } from './FileTab';
import { EnvSidebar } from './Sidebar';

export type FileView = 'keys' | 'text' | 'compare' | 'history';

const scopeNow = () => selectScope(useAppStore.getState());
const hasWorkspace = () => useAppStore.getState().activeWorkspaceId !== null;

export function openFileTab(file: { path: string; name: string }, view?: FileView): void {
  const tabs = useTabsStore.getState();
  const scope = scopeNow();
  const tab = tabs.openTab(scope, { type: 'env.file', title: file.path, data: { path: file.path, view } }, { singletonKey: `env.file:${file.path}` });
  if (view) tabs.updateTab(scope, tab.id, { data: { ...tab.data, path: file.path, view, nonce: Date.now() } });
}

/** Create an env file, optionally copied from another one (an example, usually). */
export async function createEnvFile(from?: string, suggested = '.env'): Promise<void> {
  const path = await promptDialog({
    title: from ? `New env file from ${from}` : 'New env file',
    label: 'Path (relative to the project)',
    defaultValue: suggested,
    placeholder: '.env, .env.staging, apps/web/.env.local',
    confirmLabel: 'Create',
  });
  if (!path?.trim()) return;
  try {
    const created = await invoke<EnvFileSummary>('env.file.create', from ? { path: path.trim(), from } : { path: path.trim() });
    openFileTab(created, 'keys');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function deleteEnvFile(file: { path: string }): Promise<void> {
  if (!(await confirmDialog({ title: `Delete ${file.path}?`, message: 'The file is removed from disk. Its content stays in the backup history of this workspace.', danger: true, confirmLabel: 'Delete' }))) return;
  try {
    await invoke('env.file.delete', { path: file.path });
    useTabsStore.getState().closeWhere(scopeNow(), (t) => t.type === 'env.file' && t.data?.path === file.path);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** Copy a profile over the folder's `.env`. */
export async function useEnvProfile(file: { path: string; name: string; dir: string }): Promise<void> {
  const main = file.dir ? `${file.dir}/.env` : '.env';
  if (!(await confirmDialog({ title: `Switch ${main} to ${file.name}?`, message: `${main} gets the content of ${file.name}. The current ${main} is kept as a backup (History tab).`, confirmLabel: 'Switch' }))) return;
  try {
    await invoke('env.profile.use', { path: file.path });
    notify(`${main} now has the content of ${file.name}`, 'success');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** Import the keys of a file into a Quiver environment for {{variables}}. */
export async function importIntoEnvironment(file: { path: string; name: string; profile: string | null; dir: string }): Promise<void> {
  const base = file.profile ?? file.name;
  const name = await promptDialog({
    title: `Import ${file.path} into an environment`,
    label: 'Environment name (existing or new)',
    defaultValue: file.dir ? `${file.dir}/${base}` : base,
    confirmLabel: 'Import',
  });
  if (!name?.trim()) return;
  try {
    const out = await invoke<{ environment: Environment; created: boolean; added: number; updated: number }>('env.file.import', { path: file.path, name: name.trim() });
    notify(`${out.created ? 'Created' : 'Updated'} "${out.environment.name}": ${out.added} added, ${out.updated} updated. Secret-looking keys are stored encrypted.`, 'success');
    openEnvironmentTab(out.environment);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** Write a Quiver environment into an env file (palette action). */
export async function exportEnvironment(): Promise<void> {
  let environments: Environment[];
  try {
    environments = await invoke<Environment[]>('api.environment.list', {});
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
    return;
  }
  if (!environments.length) {
    notify('No environments in this workspace yet', 'error');
    return;
  }
  const name = await promptDialog({ title: 'Export environment to an env file', label: `Environment (${environments.map((e) => e.name).join(', ')})`, defaultValue: environments[0].name, confirmLabel: 'Next' });
  if (!name?.trim()) return;
  const env = environments.find((e) => e.name.toLowerCase() === name.trim().toLowerCase());
  if (!env) {
    notify(`No environment named "${name.trim()}"`, 'error');
    return;
  }
  const path = await promptDialog({ title: `Write "${env.name}" to`, label: 'File path', defaultValue: '.env', confirmLabel: 'Export' });
  if (!path?.trim()) return;
  try {
    const out = await invoke<{ file: EnvFileSummary; exported: number }>('env.file.export', { environmentId: env.id, path: path.trim() });
    notify(`${out.exported} variables written to ${out.file.path}`, 'success');
    openFileTab(out.file, 'keys');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export const envModuleUI = defineModuleUI({
  id: 'env',
  title: 'Env files',
  icon: FileKey,
  order: 50,
  availability: 'workspace',
  Sidebar: EnvSidebar,
  tabs: {
    'env.file': FileTab,
  },
  actions: [
    { id: 'env.file.new', title: 'New env file', group: 'Env files', run: () => createEnvFile(), when: hasWorkspace },
    { id: 'env.environment.export', title: 'Export environment to an env file', group: 'Env files', run: () => exportEnvironment(), when: hasWorkspace },
  ],
});
