import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { KUBE_FORWARDABLE, KubePortForwardSpecSchema, type KubePortForward } from '@quiver/core';
import { Button, HostBridge, Icon, IconButton, Input, Select, Toasts, injectHostEvent, invokeResource } from '@quiver/ui';
import { ArrowRightLeft, Copy, Plus, X } from 'lucide';
import type { KubeLookups } from './kube-lookups';

interface ForwardForm {
  kind: (typeof KUBE_FORWARDABLE)[number];
  name: string;
  namespace: string;
  remotePort: string;
  localPort: string;
}

/** Port forwards of this cluster, each on 127.0.0.1, and a small form to start one. They outlive the tab and stop on logout and quit. */
@Component({
  selector: 'q-kube-forwards-panel',
  imports: [Button, Icon, IconButton, Input, Select],
  templateUrl: './kube-forwards-panel.html',
  host: { class: 'block border-b border-edge shrink-0', 'data-testid': 'kube-forwards' },
})
export class KubeForwardsPanel {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);

  readonly proxy = input.required<string>();
  readonly cluster = input.required<string>();
  /** The namespace the query form uses, as the starting value here. */
  readonly namespace = input.required<string>();
  readonly lookups = input.required<KubeLookups>();

  protected readonly icons = { ArrowRightLeft, Copy, Plus, X };
  protected readonly kinds = KUBE_FORWARDABLE;
  protected readonly forwards = invokeResource<KubePortForward[]>('teleport.kube.portForward.list', () => ({ proxy: this.proxy(), cluster: this.cluster() }), { workspaceId: null });
  protected readonly adding = signal(false);
  protected readonly starting = signal(false);
  protected readonly form = signal<ForwardForm>({ kind: 'services', name: '', namespace: '', remotePort: '', localPort: '' });
  protected readonly spec = computed(() => {
    const f = this.form();
    const port = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim() || undefined);
    return { kind: f.kind, name: f.name.trim(), namespace: f.namespace.trim() || this.namespace(), remotePort: port(f.remotePort), localPort: port(f.localPort) };
  });
  protected readonly valid = computed(() => KubePortForwardSpecSchema.safeParse(this.spec()).success);
  protected readonly names = computed(() => this.lookups().names(this.form().kind, this.spec().namespace));

  constructor() {
    injectHostEvent('teleport.kube.changed', (p) => {
      if (p.reason === 'forwards') this.forwards.reload();
    });
    effect(() => {
      const { kind, namespace } = this.spec();
      if (this.adding()) untracked(() => this.lookups().loadNames(kind, namespace));
    });
  }

  protected set(key: keyof ForwardForm, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected label(f: KubePortForward): string {
    return `${f.kind}/${f.name}:${f.remotePort}`;
  }

  protected title(f: KubePortForward): string {
    return [`${f.namespace} · ${f.state}${f.exitCode !== null ? ` (exit ${f.exitCode})` : ''}`, f.command, ...f.output.slice(-5)].join('\n');
  }

  protected async start(): Promise<void> {
    if (!this.valid() || this.starting()) return;
    this.starting.set(true);
    try {
      const started = await this.host.invoke<KubePortForward>('teleport.kube.portForward.start', { proxy: this.proxy(), cluster: this.cluster(), ...this.spec() }, null);
      this.toasts.notify(`Forwarding 127.0.0.1:${started.localPort} to ${this.label(started)}`, 'success');
      this.adding.set(false);
      this.form.update((f) => ({ ...f, name: '', remotePort: '', localPort: '' }));
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.starting.set(false);
      this.forwards.reload();
    }
  }

  protected stop(f: KubePortForward): void {
    this.host.invoke('teleport.kube.portForward.stop', { id: f.id }, null).catch((err) => this.toasts.error(err));
  }

  protected copy(f: KubePortForward): void {
    void navigator.clipboard.writeText(`127.0.0.1:${f.localPort}`).then(() => this.toasts.notify('Address copied', 'success'));
  }
}
