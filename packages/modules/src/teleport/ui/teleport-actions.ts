import { Service, inject, untracked } from '@angular/core';
import { clusterLabel, type DbConnectionSummary, type TeleportPin, type TeleportStatus, type TeleportTunnel } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts } from '@quiver/ui';
import { DbActions, TeleportLogin } from '../../db/ui';
import { connectionFor } from './teleport-display';

interface ConnectResult {
  tunnel: TeleportTunnel;
  connection: DbConnectionSummary | null;
  message: string | null;
}

/** What the Teleport module does: tunnels, pins, logins and the Kubernetes query view. */
@Service()
export class TeleportActions {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly db = inject(DbActions);
  private readonly login = inject(TeleportLogin);

  /** Connect flow shared by database rows and pinned rows: pick the db user, start the tunnel, reveal the connection. */
  async connectDatabase(proxy: string, name: string, allowedUsers: string[] | undefined, connections: DbConnectionSummary[] | undefined): Promise<void> {
    const existing = connectionFor(connections, proxy, name);
    let dbUser = existing?.access.type === 'teleport' ? existing.access.dbUser : '';
    if (!dbUser && allowedUsers) {
      const concrete = allowedUsers.filter((u) => u !== '*');
      if (concrete.length === 1) dbUser = concrete[0];
      else {
        const picked = await this.dialogs.prompt({
          title: `Database user for ${name}`,
          label: allowedUsers.length ? `Allowed: ${allowedUsers.join(', ')}` : 'Any user your Teleport role allows',
          defaultValue: concrete[0] ?? '',
          confirmLabel: 'Connect',
        });
        if (!picked?.trim()) return;
        dbUser = picked.trim();
      }
    }
    const result = await this.host.invoke<ConnectResult>('teleport.db.connect', { proxy, database: name, dbUser: dbUser || undefined });
    if (result.connection) {
      this.toasts.notify(`Tunnel to ${name} on 127.0.0.1:${result.tunnel.port}`, 'success');
      this.db.revealConnection(result.connection);
    } else {
      this.toasts.notify(result.message ?? `Tunnel to ${name} on 127.0.0.1:${result.tunnel.port}`, 'info');
    }
  }

  revealConnection(connection: DbConnectionSummary): void {
    this.db.revealConnection(connection);
  }

  async stopDatabase(proxy: string, name: string): Promise<void> {
    await this.host.invoke('teleport.db.disconnect', { proxy, database: name }, null);
  }

  async stopTunnel(tunnel: TeleportTunnel): Promise<void> {
    await this.host.invoke('teleport.db.disconnect', { tunnelId: tunnel.id }, null);
  }

  /** Open the read-only query view of a Kubernetes cluster. */
  openKubeQuery(proxy: string, name: string): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'teleport.kube', title: name, data: { id: `${proxy}|${name}`, proxy, cluster: name } }, { singletonKey: `teleport.kube:${proxy}|${name}` });
  }

  /** `tsh kube login`: rewrites the kubeconfig the user's terminals use. Only on an explicit, labelled request. */
  async setTerminalKubeContext(proxy: string, name: string): Promise<void> {
    await this.host.invoke('teleport.kube.login', { proxy, cluster: name }, null);
    this.toasts.notify(`kubectl in your terminals now points at ${name}`, 'success');
  }

  async setPin(pin: TeleportPin, pinned: boolean): Promise<void> {
    await this.host.invoke('teleport.pin', { ...pin, pinned }, null);
  }

  loginAgain(proxy?: string | null): Promise<boolean> {
    return this.login.loginAgain(proxy);
  }

  async addCluster(): Promise<void> {
    const proxy = await this.dialogs.prompt({ title: 'Add Teleport cluster', label: 'Proxy address', placeholder: 'teleport.example.com:443', confirmLabel: 'Add' });
    if (!proxy?.trim()) return;
    try {
      await this.host.invoke('teleport.cluster.add', { proxy: proxy.trim() }, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Palette action: log in, asking which cluster when several are known. */
  async loginFromPalette(): Promise<void> {
    try {
      const status = await this.host.invoke<TeleportStatus>('teleport.status', {}, null);
      let proxy: string | undefined;
      if (status.clusters.length > 1) {
        const preferred = status.clusters.find((c) => c.state === 'expired' || c.state === 'logged-out') ?? status.clusters[0];
        const picked = await this.dialogs.prompt({
          title: 'Log in to which cluster?',
          label: status.clusters.map((c) => `${clusterLabel(c)} (${c.proxy})`).join(', '),
          defaultValue: preferred.proxy,
          confirmLabel: 'Log in',
        });
        if (!picked?.trim()) return;
        proxy = picked.trim();
      }
      await this.login.loginAgain(proxy);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async logoutFromPalette(): Promise<void> {
    if (
      !(await this.dialogs.confirm({
        title: 'Log out of every Teleport cluster?',
        message: 'This also logs out tsh and kubectl in your terminal and stops all tunnels.',
        confirmLabel: 'Log out',
        danger: true,
      }))
    )
      return;
    try {
      await this.host.invoke('teleport.logout', {}, null);
      this.toasts.notify('Logged out of Teleport', 'info');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
