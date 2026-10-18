import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { relativeTime, type JarCookie } from '@quiver/core';
import { Button, Dialogs, EmptyState, HostBridge, IconButton, Icon, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Trash2 } from 'lucide';

interface DomainGroup {
  domain: string;
  cookies: JarCookie[];
}

/** The workspace's cookie jar: every cookie by domain, with expiry and flags, to delete one by one or clear. */
@Component({
  selector: 'q-cookie-jar-tab',
  imports: [Button, EmptyState, Icon, IconButton],
  templateUrl: './cookie-jar-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class CookieJarTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly dialogs = inject(Dialogs);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Trash2 };
  protected readonly jar = invokeResource<JarCookie[]>('api.cookie.list', () => ({}), { refreshOn: ['cookies'] });
  protected readonly filter = signal('');
  protected readonly groups = computed<DomainGroup[]>(() => {
    const q = this.filter().trim().toLowerCase();
    const byDomain = new Map<string, JarCookie[]>();
    for (const c of this.jar.value() ?? []) {
      if (q && !`${c.domain} ${c.name} ${c.path}`.toLowerCase().includes(q)) continue;
      byDomain.set(c.domain, [...(byDomain.get(c.domain) ?? []), c]);
    }
    return [...byDomain.entries()].map(([domain, cookies]) => ({ domain, cookies }));
  });
  protected readonly total = computed(() => this.jar.value()?.length ?? 0);
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected expiry(c: JarCookie): string {
    return c.expiresAt === null ? 'Session' : relativeTime(c.expiresAt - this.now());
  }

  protected flags(c: JarCookie): string {
    return [c.hostOnly ? 'host only' : 'subdomains too', c.secure ? 'Secure' : '', c.httpOnly ? 'HttpOnly' : '', c.sameSite ? `SameSite=${c.sameSite}` : ''].filter(Boolean).join(' · ');
  }

  protected async remove(c: JarCookie): Promise<void> {
    try {
      await this.host.invoke('api.cookie.delete', { domain: c.domain, path: c.path, name: c.name });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async clear(domain?: string): Promise<void> {
    const ok = await this.dialogs.confirm({ title: domain ? `Clear the cookies of ${domain}?` : 'Clear every cookie in the jar?', danger: true, confirmLabel: 'Clear' });
    if (!ok) return;
    try {
      await this.host.invoke('api.cookie.clear', domain ? { domain } : {});
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
