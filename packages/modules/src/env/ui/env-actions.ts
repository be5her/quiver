import { Service, inject, untracked } from '@angular/core';
import type { EnvFileSummary, Environment } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';
import { ApiActions } from '../../api/ui';

export type FileView = 'keys' | 'text' | 'compare' | 'history';

/** Opens, creates and deletes env files, switches profiles, and moves keys to and from Quiver environments. */
@Service()
export class EnvActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly api = inject(ApiActions);

  /** Open (or focus) the tab of a file; `view` steers it to a section. */
  openFileTab(file: { path: string; name: string }, view?: FileView): void {
    const scope = untracked(this.app.scope);
    const tab = this.tabs.openTab(scope, { type: 'env.file', title: file.path, data: { path: file.path, view } }, { singletonKey: `env.file:${file.path}` });
    if (view) this.tabs.updateTab(scope, tab.id, { data: { ...tab.data, path: file.path, view, nonce: Date.now() } });
  }

  /** Create an env file, optionally copied from another one (an example, usually). */
  async createEnvFile(from?: string, suggested = '.env'): Promise<void> {
    const path = await this.dialogs.prompt({
      title: from ? `New env file from ${from}` : 'New env file',
      label: 'Path (relative to the project)',
      defaultValue: suggested,
      placeholder: '.env, .env.staging, apps/web/.env.local',
      confirmLabel: 'Create',
    });
    if (!path?.trim()) return;
    try {
      const created = await this.host.invoke<EnvFileSummary>('env.file.create', from ? { path: path.trim(), from } : { path: path.trim() });
      this.openFileTab(created, 'keys');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async deleteEnvFile(file: { path: string }): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Delete ${file.path}?`, message: 'The file is removed from disk. Its content stays in the backup history of this workspace.', danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await this.host.invoke('env.file.delete', { path: file.path });
      this.tabs.closeWhere(untracked(this.app.scope), (t) => t.type === 'env.file' && t.data?.['path'] === file.path);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Copy a profile over the folder's `.env`. */
  async switchProfile(file: { path: string; name: string; dir: string }): Promise<void> {
    const main = file.dir ? `${file.dir}/.env` : '.env';
    if (!(await this.dialogs.confirm({ title: `Switch ${main} to ${file.name}?`, message: `${main} gets the content of ${file.name}. The current ${main} is kept as a backup (History tab).`, confirmLabel: 'Switch' }))) return;
    try {
      await this.host.invoke('env.profile.use', { path: file.path });
      this.toasts.notify(`${main} now has the content of ${file.name}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Import the keys of a file into a Quiver environment for {{variables}}. */
  async importIntoEnvironment(file: { path: string; name: string; profile: string | null; dir: string }): Promise<void> {
    const base = file.profile ?? file.name;
    const name = await this.dialogs.prompt({
      title: `Import ${file.path} into an environment`,
      label: 'Environment name (existing or new)',
      defaultValue: file.dir ? `${file.dir}/${base}` : base,
      confirmLabel: 'Import',
    });
    if (!name?.trim()) return;
    try {
      const out = await this.host.invoke<{ environment: Environment; created: boolean; added: number; updated: number }>('env.file.import', { path: file.path, name: name.trim() });
      this.toasts.notify(`${out.created ? 'Created' : 'Updated'} "${out.environment.name}": ${out.added} added, ${out.updated} updated. Secret-looking keys are stored encrypted.`, 'success');
      this.api.openEnvironmentTab(out.environment);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Write a Quiver environment into an env file (palette action). */
  async exportEnvironment(): Promise<void> {
    let environments: Environment[];
    try {
      environments = await this.host.invoke<Environment[]>('api.environment.list', {});
    } catch (err) {
      this.toasts.error(err);
      return;
    }
    if (!environments.length) {
      this.toasts.notify('No environments in this workspace yet', 'error');
      return;
    }
    const name = await this.dialogs.prompt({ title: 'Export environment to an env file', label: `Environment (${environments.map((e) => e.name).join(', ')})`, defaultValue: environments[0].name, confirmLabel: 'Next' });
    if (!name?.trim()) return;
    const env = environments.find((e) => e.name.toLowerCase() === name.trim().toLowerCase());
    if (!env) {
      this.toasts.notify(`No environment named "${name.trim()}"`, 'error');
      return;
    }
    const path = await this.dialogs.prompt({ title: `Write "${env.name}" to`, label: 'File path', defaultValue: '.env', confirmLabel: 'Export' });
    if (!path?.trim()) return;
    try {
      const out = await this.host.invoke<{ file: EnvFileSummary; exported: number }>('env.file.export', { environmentId: env.id, path: path.trim() });
      this.toasts.notify(`${out.exported} variables written to ${out.file.path}`, 'success');
      this.openFileTab(out.file, 'keys');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
