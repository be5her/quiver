import { Component, inject, input, signal } from '@angular/core';
import { Button, Dialogs, EmptyState, HostBridge, IconButton, Icon, Input, Toasts, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Pencil, Plus, Trash2 } from 'lucide';
import { ApiActions } from './api-actions';

/** A certificate as api.certificate.list gives it: no passphrase, only whether one is kept. */
interface CertificateView {
  id: string;
  hostPattern: string;
  certPath: string;
  keyPath: string;
  pfxPath: string;
  caPath: string;
  hasPassphrase: boolean;
}

interface Draft {
  id?: string;
  hostPattern: string;
  certPath: string;
  keyPath: string;
  pfxPath: string;
  caPath: string;
  passphrase: string;
  hasPassphrase: boolean;
}

const EMPTY: Draft = { hostPattern: '', certPath: '', keyPath: '', pfxPath: '', caPath: '', passphrase: '', hasPassphrase: false };

/**
 * Client certificates of the workspace, on this machine: a host pattern and the files to present
 * (PEM certificate and key, or a PKCS#12 file), an optional CA, a passphrase kept encrypted.
 */
@Component({
  selector: 'q-certificates-tab',
  imports: [Button, EmptyState, Icon, IconButton, Input],
  templateUrl: './certificates-tab.html',
  host: { class: 'flex flex-col h-full min-h-0' },
})
export class CertificatesTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly dialogs = inject(Dialogs);
  private readonly api = inject(ApiActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Pencil, Plus, Trash2 };
  protected readonly list = invokeResource<CertificateView[]>('api.certificate.list', () => ({}), { refreshOn: ['certificates'] });
  /** The certificate being added or edited, or null. */
  protected readonly draft = signal<Draft | null>(null);

  protected add(): void {
    this.draft.set({ ...EMPTY });
  }

  protected edit(c: CertificateView): void {
    this.draft.set({ ...c, passphrase: '' });
  }

  protected set(key: keyof Draft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((d) => (d ? { ...d, [key]: value } : d));
  }

  protected async pick(key: 'certPath' | 'keyPath' | 'pfxPath' | 'caPath', title: string): Promise<void> {
    const picked = await this.api.pickRequestFile(title);
    if (picked) this.draft.update((d) => (d ? { ...d, [key]: picked } : d));
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    try {
      await this.host.invoke('api.certificate.save', {
        certificate: {
          ...(d.id ? { id: d.id } : {}),
          hostPattern: d.hostPattern,
          certPath: d.certPath,
          keyPath: d.keyPath,
          pfxPath: d.pfxPath,
          caPath: d.caPath,
          ...(d.passphrase ? { passphrase: d.passphrase } : {}),
        },
      });
      this.draft.set(null);
      this.toasts.notify('Certificate saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected async remove(c: CertificateView): Promise<void> {
    if (!(await this.dialogs.confirm({ title: `Remove the certificate for ${c.hostPattern}?`, message: 'The files stay where they are.', danger: true, confirmLabel: 'Remove' }))) return;
    await this.host.invoke('api.certificate.delete', { id: c.id }).catch((err) => this.toasts.error(err));
  }

  protected files(c: CertificateView): string {
    return c.pfxPath ? c.pfxPath : [c.certPath, c.keyPath].filter(Boolean).join(' + ');
  }
}
