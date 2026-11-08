import { Component, inject, input, signal } from '@angular/core';
import type { TeleportClusterStatus, TeleportKubeCluster } from '@quiver/core';
import { ContextMenu, Dialogs, HostBridge, Icon, IconButton, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { Boxes, Pin, PinOff, ShieldAlert, Terminal } from 'lucide';
import { DbError } from '../../db/ui';
import { TeleportActions } from './teleport-actions';
import { isTerminalKube } from './teleport-display';
import { TeleportSubHeader } from './teleport-sub-header';

/** The Kubernetes clusters of one Teleport cluster: open the query view, pin, protect, or point the terminal at one. */
@Component({
  selector: 'q-teleport-kubes',
  imports: [DbError, Icon, IconButton, Spinner, TeleportSubHeader],
  templateUrl: './teleport-kubes.html',
  host: { class: 'block mt-1' },
})
export class TeleportKubes {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly menu = inject(ContextMenu);
  protected readonly actions = inject(TeleportActions);

  readonly cluster = input.required<TeleportClusterStatus>();

  protected readonly icons = { Boxes, Pin, PinOff, ShieldAlert, Terminal };
  protected readonly busy = signal<string | null>(null);
  protected readonly kubes = invokeResource<TeleportKubeCluster[]>('teleport.kube.list', () => ({ proxy: this.cluster().proxy }), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });

  protected isActive(kube: TeleportKubeCluster): boolean {
    return isTerminalKube(this.cluster(), kube.name);
  }

  protected title(kube: TeleportKubeCluster): string {
    return [
      `Query ${kube.name}, or run an action on it`,
      ...(kube.protected ? ['Protected: actions need its name typed, and agents may not run them'] : []),
      ...Object.entries(kube.labels).map(([a, b]) => `${a}=${b}`),
    ].join('\n');
  }

  protected openMenu(event: MouseEvent, kube: TeleportKubeCluster): void {
    this.menu.open(event, [
      { label: 'Open', select: () => this.actions.openKubeQuery(kube.proxy, kube.name) },
      { label: kube.pinned ? 'Unpin' : 'Pin', select: () => this.actions.setPin({ proxy: kube.proxy, kind: 'kube', name: kube.name }, !kube.pinned).catch((err) => this.toasts.error(err)) },
      { label: 'Set as kubectl context for my terminal', disabled: this.isActive(kube), select: () => void this.useInTerminal(event, kube) },
      'separator',
      { label: 'Protected', checked: kube.protected, testId: 'kube-menu-protect', select: () => void this.toggleProtected(kube) },
    ]);
  }

  /** Protecting asks nothing; unprotecting says what it turns off. */
  private async toggleProtected(kube: TeleportKubeCluster): Promise<void> {
    if (
      kube.protected &&
      !(await this.dialogs.confirm({
        title: `Stop protecting ${kube.name}?`,
        message: 'Actions on it will no longer ask for its name, and agents with mutations allowed can run them.',
        confirmLabel: 'Stop protecting',
        danger: true,
      }))
    )
      return;
    try {
      await this.actions.setKubeProtected(kube.proxy, kube.name, !kube.protected);
      this.kubes.reload();
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected refresh(): void {
    this.host.invoke('teleport.kube.list', { proxy: this.cluster().proxy, refresh: true }, null).then(
      () => this.kubes.reload(),
      (err) => this.toasts.error(err),
    );
  }

  protected togglePin(event: MouseEvent, kube: TeleportKubeCluster): void {
    event.stopPropagation();
    this.actions.setPin({ proxy: kube.proxy, kind: 'kube', name: kube.name }, !kube.pinned).catch((err) => this.toasts.error(err));
  }

  protected async useInTerminal(event: MouseEvent, kube: TeleportKubeCluster): Promise<void> {
    event.stopPropagation();
    const ok = await this.dialogs.confirm({
      title: `Point your terminal's kubectl at ${kube.name}?`,
      message: 'This runs tsh kube login, which changes the current context in the kubeconfig your terminals use. Querying the cluster in Quiver does not need it.',
      confirmLabel: 'Set terminal context',
    });
    if (!ok) return;
    this.busy.set(kube.name);
    try {
      await this.actions.setTerminalKubeContext(kube.proxy, kube.name);
      this.kubes.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(null);
    }
  }
}
