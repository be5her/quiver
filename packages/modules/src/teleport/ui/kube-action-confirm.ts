import { Component, computed, input, output, signal } from '@angular/core';
import { kubeActionInfo, type KubeActionPreview } from '@quiver/core';
import { Autofocus, Button, Icon, Input } from '@quiver/ui';
import { ShieldAlert, TriangleAlert } from 'lucide';

/** What the user confirmed: the cluster name they typed, for a protected cluster. */
export interface KubeActionConfirmed {
  preview: KubeActionPreview;
  confirmCluster?: string;
}

/**
 * Every action runs through this: it shows the exact command line that will be spawned, and asks
 * for the object's name typed for a destructive action and for the cluster's name typed on a
 * protected cluster. Run stays disabled until what was typed matches.
 */
@Component({
  selector: 'q-kube-action-confirm',
  imports: [Autofocus, Button, Icon, Input],
  templateUrl: './kube-action-confirm.html',
  host: { class: 'contents' },
})
export class KubeActionConfirm {
  readonly preview = input.required<KubeActionPreview>();
  readonly cluster = input.required<string>();
  readonly proxy = input.required<string>();
  readonly confirmed = output<KubeActionConfirmed>();
  readonly cancelled = output<void>();

  protected readonly icons = { ShieldAlert, TriangleAlert };
  protected readonly typedName = signal('');
  protected readonly typedCluster = signal('');
  protected readonly title = computed(() => {
    const p = this.preview();
    return `${kubeActionInfo(p.action.action)?.title ?? p.action.action} ${p.target.kind}/${p.target.name}?`;
  });
  protected readonly nameOk = computed(() => !this.preview().destructive || this.typedName().trim() === this.preview().target.name);
  protected readonly clusterOk = computed(() => !this.preview().protected || this.typedCluster().trim() === this.cluster());
  protected readonly ready = computed(() => this.nameOk() && this.clusterOk());

  protected typed(which: 'name' | 'cluster', event: Event): void {
    (which === 'name' ? this.typedName : this.typedCluster).set((event.target as HTMLInputElement).value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.ready()) return;
    const preview = this.preview();
    this.confirmed.emit({ preview, ...(preview.protected ? { confirmCluster: this.typedCluster().trim() } : {}) });
  }
}
