import { Component, effect, inject, input, signal } from '@angular/core';
import type { TeleportClusterStatus, TeleportKubeCluster } from '@quiver/core';
import { Dialogs, HostBridge, Icon, IconButton, Spinner, Toasts, invokeResource } from '@quiver/ui';
import { Boxes, Pin, PinOff, Terminal } from 'lucide';
import { DbError } from '../../db/ui';
import { TeleportActions } from './teleport-actions';
import { TeleportSubHeader } from './teleport-sub-header';
import { TeleportViewState } from './teleport-view-state';

/** The Kubernetes clusters of one Teleport cluster: open the read-only query view, pin, or point the terminal at one. */
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
  private readonly view = inject(TeleportViewState);
  protected readonly actions = inject(TeleportActions);

  readonly cluster = input.required<TeleportClusterStatus>();

  protected readonly icons = { Boxes, Pin, PinOff, Terminal };
  protected readonly busy = signal<string | null>(null);
  protected readonly kubes = invokeResource<TeleportKubeCluster[]>('teleport.kube.list', () => ({ proxy: this.cluster().proxy }), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });

  constructor() {
    effect(() => {
      const kubes = this.kubes.value();
      if (kubes) this.view.setKubes(this.cluster().proxy, kubes);
    });
  }

  protected isActive(kube: TeleportKubeCluster): boolean {
    return kube.selected || this.cluster().kubeCluster === kube.name;
  }

  protected title(kube: TeleportKubeCluster): string {
    return [`Query ${kube.name} (read-only)`, ...Object.entries(kube.labels).map(([a, b]) => `${a}=${b}`)].join('\n');
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
