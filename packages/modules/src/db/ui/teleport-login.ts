import { Service, inject } from '@angular/core';
import type { TeleportLoginResult } from '@quiver/core';
import { HostBridge, Toasts } from '@quiver/ui';

/** `tsh login` for a cluster from anywhere in the app, reporting the outcome. */
@Service()
export class TeleportLogin {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  /** Resolves to true when the cluster's session is valid again. */
  async loginAgain(proxy?: string | null): Promise<boolean> {
    try {
      const result = await this.host.invoke<TeleportLoginResult>('teleport.login', proxy ? { proxy } : {}, null);
      const cluster = result.status.clusters.find((c) => c.proxy === result.proxy);
      if (result.ok) this.toasts.notify(`Logged in to ${cluster?.cluster ?? result.proxy} as ${cluster?.user ?? 'user'}`, 'success');
      else this.toasts.notify(result.output.at(-1) ?? 'Teleport login did not complete', 'error');
      return result.ok;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }
}
