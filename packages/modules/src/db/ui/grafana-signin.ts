import { Service, inject } from '@angular/core';
import type { LogsSession } from '@quiver/core';
import { HostBridge, Toasts } from '@quiver/ui';

/** Grafana's sign-in window for Redis through a data source: the same session as the Logs module, one per Grafana. */
@Service()
export class GrafanaSignIn {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  /** Resolves to true once this machine is signed in to that Grafana. */
  async signIn(grafanaUrl: string): Promise<boolean> {
    try {
      const session = await this.host.invoke<LogsSession>('db.grafana.signin', { grafanaUrl });
      if (session.state === 'signed-in') this.toasts.notify(`Signed in to Grafana as ${session.user?.email || session.user?.login || 'you'}`, 'success');
      else if (session.error) this.toasts.notify(session.error, 'error');
      return session.state === 'signed-in';
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }
}
