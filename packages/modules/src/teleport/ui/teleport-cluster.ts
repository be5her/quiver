import { Component, computed, inject, input, signal } from '@angular/core';
import { clusterLabel, formatRemaining, sameProxy, type DbConnectionSummary, type TeleportClusterStatus, type TeleportStatus } from '@quiver/core';
import { Button, Dialogs, HostBridge, Icon, IconButton, Spinner, Toasts } from '@quiver/ui';
import { ChevronDown, ChevronRight, LogIn, LogOut, Terminal, Trash2, X } from 'lucide';
import { TeleportActions } from './teleport-actions';
import { TeleportDatabases } from './teleport-databases';
import { STATE_DOT, STATE_LABEL, isUsable } from './teleport-display';
import { TeleportKubes } from './teleport-kubes';
import { TeleportLoginLog } from './teleport-login-log';
import { TeleportViewState, clock } from './teleport-view-state';

/** One cluster (a tsh profile): its login state and countdown, then its databases and Kubernetes clusters. */
@Component({
  selector: 'q-teleport-cluster',
  imports: [Button, Icon, IconButton, Spinner, TeleportDatabases, TeleportKubes, TeleportLoginLog],
  templateUrl: './teleport-cluster.html',
  host: { class: 'block mt-1', 'data-testid': 'teleport-cluster', '[attr.data-state]': 'cluster().state', '[attr.data-proxy]': 'cluster().proxy' },
})
export class TeleportCluster {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly actions = inject(TeleportActions);
  private readonly view = inject(TeleportViewState);

  readonly cluster = input.required<TeleportClusterStatus>();
  readonly status = input.required<TeleportStatus>();
  readonly connections = input<DbConnectionSummary[]>();

  protected readonly icons = { ChevronDown, ChevronRight, LogIn, LogOut, Terminal, Trash2, X };
  protected readonly stateDot = STATE_DOT;
  private readonly now = clock(30_000);
  protected readonly busy = signal<'login' | 'logout' | null>(null);
  protected readonly showLog = signal(false);
  protected readonly label = computed(() => clusterLabel(this.cluster()));
  protected readonly collapsed = computed(() => Boolean(this.view.collapsed()[this.cluster().proxy]));
  protected readonly usable = computed(() => isUsable(this.cluster()));
  protected readonly loggingIn = computed(() => this.status().loginInProgress && sameProxy(this.status().loginProxy, this.cluster().proxy));
  protected readonly lastLogHere = computed(() => {
    const status = this.status();
    return !status.loginInProgress && sameProxy(status.loginProxy, this.cluster().proxy) && status.loginOutput.length > 0;
  });
  protected readonly remaining = computed(() => formatRemaining(this.cluster().validUntil, this.now()));
  protected readonly title = computed(() => {
    const c = this.cluster();
    return `${c.proxy}\n${STATE_LABEL[c.state]}${c.validUntil ? `\nValid until ${new Date(c.validUntil).toLocaleString()}` : ''}`;
  });
  protected readonly expiredAt = computed(() => {
    const until = this.cluster().validUntil;
    return until ? new Date(until).toLocaleString() : '';
  });

  protected toggle(): void {
    this.view.toggle(this.cluster().proxy);
  }

  protected async login(event?: MouseEvent): Promise<void> {
    event?.stopPropagation();
    this.busy.set('login');
    try {
      await this.actions.loginAgain(this.cluster().proxy);
    } finally {
      this.busy.set(null);
    }
  }

  protected async logout(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const label = this.label();
    const ok = await this.dialogs.confirm({
      title: `Log out of ${label}?`,
      message: 'This also logs out tsh and kubectl in your terminal for this cluster and stops its tunnels.',
      confirmLabel: 'Log out',
      danger: true,
    });
    if (!ok) return;
    this.busy.set('logout');
    try {
      await this.host.invoke('teleport.logout', { proxy: this.cluster().proxy }, null);
      this.toasts.notify(`Logged out of ${label}`);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async remove(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const ok = await this.dialogs.confirm({
      title: `Remove ${this.label()} from Quiver?`,
      message: 'Its pins are removed and its tunnels stopped. The tsh profile stays on disk.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.host.invoke('teleport.cluster.remove', { proxy: this.cluster().proxy }, null).catch((err) => this.toasts.error(err));
  }

  protected cancelLogin(): void {
    this.host.invoke('teleport.login.cancel', {}, null).catch(() => {});
  }
}
