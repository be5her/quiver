import { effect, inject, signal, untracked, type Signal } from '@angular/core';
import { KUBE_RESOURCE_TYPES, kubeQueryErrors, parseKubectlNames, parsePodContainers, type KubeQuery, type KubeRunResult } from '@quiver/core';
import { HostBridge } from '@quiver/ui';

/**
 * Picker data from the same read-only catalogue: namespaces from `namespaces`, names from `list` of
 * the chosen type, containers from `get pods <name> -o json`. None of these land in the history.
 */
export interface KubeLookups {
  readonly namespaces: Signal<string[]>;
  /** Names of `resource` in `namespace`, once fetched. Reactive. */
  names(resource: string, namespace: string): string[];
  /** Containers of `pod`, once fetched. Reactive. */
  containers(namespace: string, pod: string): string[];
  /** Start fetching the names a field needs; nothing happens when they are cached or on their way. */
  loadNames(resource: string, namespace: string): void;
  loadContainers(namespace: string, pod: string): void;
}

/** Lookups for one cluster. Call in an injection context; the namespaces load as soon as the cluster is known. */
export function kubeLookups(proxy: () => string, cluster: () => string): KubeLookups {
  const host = inject(HostBridge);
  const namespaces = signal<string[]>([]);
  const names = signal<Record<string, string[]>>({});
  const containers = signal<Record<string, string[]>>({});
  const pending = new Set<string>();

  const lookup = async (key: string, query: KubeQuery, parse: (stdout: string) => string[], store: (list: string[]) => void) => {
    if (pending.has(key)) return;
    pending.add(key);
    try {
      const out = await host.invoke<KubeRunResult>('teleport.kube.query', { proxy: untracked(proxy), cluster: untracked(cluster), query, record: false, timeoutSeconds: 30 }, null);
      store(out.exitCode === 0 ? parse(out.stdout) : []);
    } catch {
      store([]);
    }
  };

  effect(() => {
    proxy();
    cluster();
    untracked(() => void lookup('namespaces', { operation: 'namespaces', params: {} }, parseKubectlNames, (list) => namespaces.set(list)));
  });

  return {
    namespaces: namespaces.asReadonly(),
    names: (resource, namespace) => names()[`${resource}\n${namespace}`] ?? [],
    containers: (namespace, pod) => containers()[`${namespace}\n${pod}`] ?? [],
    loadNames: (resource, namespace) => {
      const key = `${resource}\n${namespace}`;
      if (key in untracked(names) || !(KUBE_RESOURCE_TYPES as readonly string[]).includes(resource)) return;
      void lookup(key, { operation: 'list', params: { resource, namespace } } as KubeQuery, parseKubectlNames, (list) => names.update((m) => ({ ...m, [key]: list })));
    },
    loadContainers: (namespace, pod) => {
      const key = `${namespace}\n${pod}`;
      if (key in untracked(containers) || kubeQueryErrors({ operation: 'get', params: { resource: 'pods', name: pod, namespace } }).name !== undefined) return;
      void lookup(key, { operation: 'get', params: { resource: 'pods', name: pod, namespace, output: 'json' } }, parsePodContainers, (list) => containers.update((m) => ({ ...m, [key]: list })));
    },
  };
}
