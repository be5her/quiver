import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import {
  KUBE_ACTIONS,
  KUBE_OPERATIONS,
  buildKubeActionArgs,
  buildKubectlArgs,
  formatCommandLine,
  isKubeActionId,
  kubeActionErrors,
  kubeActionInfo,
  kubeActionTarget,
  kubeOperationInfo,
  kubeQueryErrors,
  newId,
  toErrorPayload,
  type ErrorPayload,
  type KubeAction,
  type KubeActionField,
  type KubeActionId,
  type KubeActionPreview,
  type KubeActionResult,
  type KubeField,
  type KubeHistoryEntry,
  type KubeOperation,
  type KubePreview,
  type KubeQuery,
  type KubeRunResult,
  type KubeStreamRead,
  type TeleportKubeCluster,
} from '@quiver/core';
import { Button, Dialogs, HostBridge, Icon, IconButton, Select, Spinner, Toasts, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Boxes, Copy, Info, Play, ShieldAlert, Square, Terminal, Zap } from 'lucide';
import { KubeActionConfirm, type KubeActionConfirmed } from './kube-action-confirm';
import { KubeFieldBox } from './kube-field-box';
import { KubeFieldEditor } from './kube-field-editor';
import { KubeForwardsPanel } from './kube-forwards-panel';
import { KubeHistoryPanel } from './kube-history-panel';
import { kubeLookups } from './kube-lookups';
import { KubeOutputPanel } from './kube-output-panel';
import { toAction, toQuery, type KubeValues } from './kube-query-model';

/** Lines kept in the output panel while following logs; older ones scroll away. */
const FOLLOW_BUFFER = 5000;
const DEFAULT_TAIL = 200;

interface HistoryData {
  entries: KubeHistoryEntry[];
  lastNamespace: string | null;
}

/**
 * One Kubernetes cluster reached through Teleport: pick a read-only operation, or a write action
 * from the separate catalogue, fill in its typed fields and run it with `tsh kubectl`. There is no
 * free-form command line anywhere; the preview shows what the host will run and is not editable,
 * and every action goes through a confirmation that shows the exact command line.
 */
@Component({
  selector: 'q-kube-query-tab',
  imports: [Button, Icon, IconButton, KubeActionConfirm, KubeFieldBox, KubeFieldEditor, KubeForwardsPanel, KubeHistoryPanel, KubeOutputPanel, Select, Spinner],
  templateUrl: './kube-query-tab.html',
  host: { class: 'flex h-full min-h-0', 'data-testid': 'kube-query', '[attr.data-cluster]': 'cluster()' },
})
export class KubeQueryTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Boxes, Copy, Info, Play, ShieldAlert, Square, Terminal, Zap };
  protected readonly operations = KUBE_OPERATIONS;
  protected readonly actions = KUBE_ACTIONS;
  protected readonly proxy = computed(() => String(this.tab().data?.['proxy'] ?? ''));
  protected readonly cluster = computed(() => String(this.tab().data?.['cluster'] ?? ''));
  /** A read operation or a write action; the two catalogues share no ids. */
  protected readonly operation = signal<KubeOperation | KubeActionId>('list');
  protected readonly values = signal<KubeValues>({ resource: 'pods' });
  /** Fields the user changed; their errors show before the field has a value. */
  private readonly touched = signal<Record<string, boolean>>({});
  protected readonly running = signal<{ runId: string; streaming: boolean } | null>(null);
  protected readonly stopping = signal(false);
  protected readonly result = signal<KubeRunResult | KubeActionResult | null>(null);
  protected readonly lines = signal<string[]>([]);
  protected readonly stream = signal<KubeStreamRead | null>(null);
  protected readonly error = signal<ErrorPayload | null>(null);
  /** The action waiting in the confirmation dialog, previewed by the host. */
  protected readonly confirming = signal<KubeActionPreview | null>(null);
  private next = 0;

  protected readonly lookups = kubeLookups(this.proxy, this.cluster);
  protected readonly history = invokeResource<HistoryData>('teleport.kube.history.list', () => ({ proxy: this.proxy(), cluster: this.cluster() }), { workspaceId: null });
  private readonly kubes = invokeResource<TeleportKubeCluster[]>('teleport.kube.list', () => ({ proxy: this.proxy() }), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });
  protected readonly isProtected = computed(() => Boolean(this.kubes.value()?.find((k) => k.name === this.cluster())?.protected));

  protected readonly isAction = computed(() => isKubeActionId(this.operation()));
  private readonly actionId = computed(() => (this.isAction() ? (this.operation() as KubeActionId) : null));
  protected readonly info = computed(() => {
    const id = this.actionId();
    return id ? kubeActionInfo(id)! : kubeOperationInfo(this.operation())!;
  });
  protected readonly fields = computed<readonly (KubeField | KubeActionField)[]>(() => this.info().fields);
  protected readonly query = computed(() => (this.isAction() ? null : toQuery(this.operation() as KubeOperation, this.values())));
  protected readonly action = computed(() => {
    const id = this.actionId();
    return id ? toAction(id, this.values()) : null;
  });
  protected readonly errors = computed(() => {
    const action = this.action();
    return action ? kubeActionErrors(action) : kubeQueryErrors(this.query());
  });
  protected readonly valid = computed(() => Object.keys(this.errors()).length === 0);
  /** Action name fields look up names of the type the action changes. */
  protected readonly nameKind = computed(() => {
    const action = this.action();
    if (!action) return null;
    const kind = (action.params as { kind?: string }).kind;
    return action.action === 'rollout-pause' || action.action === 'rollout-resume' ? 'deployments' : action.action === 'cronjob-trigger' ? 'cronjobs' : (kind ?? null);
  });
  // The host builds the preview from the same argv it would spawn: tsh path, template, kubeconfig and context.
  private readonly previewed = invokeResource<KubePreview>('teleport.kube.preview', () => ({ proxy: this.proxy(), cluster: this.cluster(), query: this.query() }), {
    workspaceId: null,
    enabled: () => this.valid() && !this.isAction(),
  });
  private readonly actionPreviewed = invokeResource<KubeActionPreview>('teleport.kube.action.preview', () => ({ proxy: this.proxy(), cluster: this.cluster(), action: this.action() }), {
    workspaceId: null,
    enabled: () => this.valid() && this.isAction(),
  });
  protected readonly preview = computed<KubePreview | undefined>(() => (!this.valid() ? undefined : this.isAction() ? this.actionPreviewed.value() : this.previewed.value()));
  /** What the box shows: the kubectl part. The exact line (tsh path, --kubeconfig, --context) is its tooltip and what Copy copies. */
  protected readonly shortCommand = computed(() => {
    if (!this.valid()) return null;
    const action = this.action();
    if (!action) {
      const query = this.query()!;
      return formatCommandLine(['kubectl', ...buildKubectlArgs(query.operation, query.params)]);
    }
    // A CronJob trigger gets its job name from the host's preview; every other action builds here.
    const resolved = action.action === 'cronjob-trigger' && !action.params.jobName ? this.actionPreviewed.value()?.action : action;
    return resolved ? formatCommandLine(['kubectl', ...buildKubeActionArgs(resolved.action, resolved.params)]) : null;
  });
  protected readonly infoTitle = computed(() =>
    [
      this.isAction()
        ? `${this.info().description}. Changes the cluster: Run shows the exact command and asks you to confirm.`
        : `${this.info().description}. Read-only: your terminal's kubectl context is not changed.`,
      'Hover the command for the exact line that runs; Copy copies it.',
      this.preview()?.setup ? `The first run on this cluster prepares its private kubeconfig once with:\n${this.preview()!.setup}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  protected readonly namespace = computed(() => {
    const ns = this.values()['namespace'];
    return typeof ns === 'string' && ns.trim() ? ns.trim() : 'default';
  });
  protected readonly exitCode = computed(() => {
    const stream = this.stream();
    return stream ? stream.exitCode : this.result()?.exitCode;
  });
  protected readonly durationMs = computed(() => {
    const stream = this.stream();
    return stream ? stream.durationMs : this.result()?.durationMs;
  });
  protected readonly stderr = computed(() => {
    const stream = this.stream();
    return (stream ? stream.stderr : this.result()?.stderr) ?? '';
  });
  protected readonly truncated = computed(() => Boolean(this.result()?.truncated) || (this.stream()?.dropped ?? 0) > 0);
  protected readonly ran = computed(() => {
    const result = this.result();
    return result ? { command: result.command, setup: result.setup } : null;
  });
  protected readonly hasResult = computed(() => Boolean(this.result()) || Boolean(this.error()));

  constructor() {
    // The namespace last used on this cluster comes back from its history, once.
    let seeded = false;
    effect(() => {
      const data = this.history.value();
      if (seeded || !data) return;
      seeded = true;
      const ns = data.lastNamespace;
      if (ns) untracked(() => this.values.update((v) => (v['namespace'] ? v : { ...v, namespace: ns })));
    });

    injectHostEvent('teleport.kube.changed', (p) => {
      if (p.reason === 'history') this.history.reload();
      // Follow-logs: pull new lines whenever the host says the stream moved.
      const running = this.running();
      if (p.reason === 'stream' && running?.streaming && p.runId === running.runId) void this.pull(running.runId);
    });

    // Stop a followed log when its tab closes.
    inject(DestroyRef).onDestroy(() => {
      const running = this.running();
      if (running) this.host.invoke('teleport.kube.cancel', { runId: running.runId }, null).catch(() => {});
    });
  }

  /** The error to show under a field: once it was changed, or as soon as it has a value. */
  protected fieldError(key: string): string | undefined {
    return this.touched()[key] || this.values()[key] !== undefined ? this.errors()[key] : undefined;
  }

  protected setField(key: string, value: KubeValues[string]): void {
    this.values.update((v) => ({ ...v, [key]: value }));
    this.touched.update((t) => ({ ...t, [key]: true }));
  }

  /** Switching the operation keeps what carries over: namespace, type, names, pod, container, tail. */
  protected pickOperation(event: Event): void {
    const next = (event.target as HTMLSelectElement).value as KubeOperation | KubeActionId;
    this.operation.set(next);
    this.touched.set({});
    this.values.update((v) => {
      const keep: KubeValues = { namespace: v['namespace'], resource: v['resource'] ?? 'pods', pod: v['pod'], container: v['container'], name: v['name'], kind: v['kind'] };
      if ((next === 'logs' || next === 'logs-follow') && v['tail'] === undefined) keep['tail'] = next === 'logs' ? DEFAULT_TAIL : 100;
      else keep['tail'] = v['tail'];
      if (next === 'can-i') keep['verb'] = v['verb'] ?? 'get';
      if (isKubeActionId(next)) {
        // The type list differs per action: keep the type when this action takes it, else start from its first one.
        const options = kubeActionInfo(next)?.fields.find((f) => f.kind === 'workload')?.options;
        if (options) keep['kind'] = options.includes(String(v['kind'])) ? v['kind'] : options.includes(String(v['resource'])) ? v['resource'] : options[0];
        if (next === 'scale') keep['replicas'] = v['replicas'] ?? 1;
        if (next === 'cordon' || next === 'uncordon') keep['node'] = v['node'];
      }
      return keep;
    });
  }

  protected fillFrom(entry: KubeHistoryEntry): void {
    if (entry.kind === 'action') {
      this.operation.set(entry.action.action);
      this.values.set({ ...(entry.action.params as KubeValues) });
    } else {
      this.operation.set(entry.query.operation);
      this.values.set({ ...(entry.query.params as KubeValues) });
    }
    this.touched.set({});
  }

  /** A query runs again at once; an action goes through the confirmation again, like the first time. */
  protected rerun(entry: KubeHistoryEntry): void {
    this.fillFrom(entry);
    if (entry.kind === 'action') {
      // A job name cannot be used twice: a rerun gets a fresh default one.
      const action = entry.action.action === 'cronjob-trigger' ? ({ ...entry.action, params: { ...entry.action.params, jobName: undefined } } as KubeAction) : entry.action;
      if (action !== entry.action) this.values.update((v) => ({ ...v, jobName: undefined }));
      void this.confirmAction(action);
    } else void this.run(entry.query);
  }

  /** Run: a query runs; an action is previewed by the host and waits for the confirmation. */
  protected go(): void {
    const action = this.action();
    if (action) void this.confirmAction(action);
    else void this.run();
  }

  private async confirmAction(action: KubeAction): Promise<void> {
    if (this.running() || this.confirming()) return;
    try {
      // A fresh preview: it carries the protection state and the resolved action that will run.
      this.confirming.set(await this.host.invoke<KubeActionPreview>('teleport.kube.action.preview', { proxy: this.proxy(), cluster: this.cluster(), action }, null));
    } catch (err) {
      this.error.set(toErrorPayload(err));
    }
  }

  protected async runAction({ preview, confirmCluster }: KubeActionConfirmed): Promise<void> {
    this.confirming.set(null);
    if (this.running()) return;
    const runId = newId();
    this.running.set({ runId, streaming: false });
    this.stopping.set(false);
    this.error.set(null);
    this.stream.set(null);
    this.result.set(null);
    this.lines.set([]);
    try {
      const out = await this.host.invoke<KubeActionResult>('teleport.kube.action', { proxy: this.proxy(), cluster: this.cluster(), action: preview.action, runId, confirmCluster }, null);
      this.result.set(out);
      this.lines.set(out.stdout ? out.stdout.split('\n') : []);
      const target = kubeActionTarget(preview.action);
      if (out.exitCode === 0) this.toasts.notify(`${kubeActionInfo(preview.action.action)?.title ?? 'Action'}: ${target.kind}/${target.name} on ${this.cluster()}`, 'success');
    } catch (err) {
      this.error.set(toErrorPayload(err));
    }
    this.running.set(null);
    this.actionPreviewed.reload();
  }

  protected async run(query: KubeQuery | null = this.query()): Promise<void> {
    if (this.running() || !query) return;
    const runId = newId();
    const streaming = Boolean(kubeOperationInfo(query.operation)?.streaming);
    this.running.set({ runId, streaming });
    this.stopping.set(false);
    this.error.set(null);
    this.stream.set(null);
    this.result.set(null);
    this.lines.set([]);
    this.next = 0;
    try {
      const out = await this.host.invoke<KubeRunResult>('teleport.kube.query', { proxy: this.proxy(), cluster: this.cluster(), query, runId }, null);
      this.result.set(out);
      if (out.streaming) {
        await this.pull(runId);
      } else {
        this.lines.set(out.stdout ? out.stdout.split('\n') : []);
        this.running.set(null);
      }
    } catch (err) {
      this.error.set(toErrorPayload(err));
      this.running.set(null);
    }
    this.previewed.reload();
  }

  /** The host ends the run (and says so through the stream) once the process tree is gone. */
  protected stop(): void {
    const running = this.running();
    if (!running || this.stopping()) return;
    const { runId } = running;
    this.stopping.set(true);
    this.host.invoke<{ cancelled: boolean }>('teleport.kube.cancel', { runId }, null).then(
      // Nothing to stop on the host (it already ended, or Quiver restarted): free the form.
      (out) => !out.cancelled && this.endRun(runId),
      (err) => {
        this.stopping.set(false);
        this.toasts.error(err);
      },
    );
  }

  protected copyPreview(command: string): void {
    void navigator.clipboard.writeText(command).then(() => this.toasts.notify('Command copied', 'success'));
  }

  protected async setTerminalContext(): Promise<void> {
    const cluster = this.cluster();
    const ok = await this.dialogs.confirm({
      title: `Point your terminal's kubectl at ${cluster}?`,
      message: 'This runs tsh kube login, which changes the current context in the kubeconfig your terminals use. Queries in this view never need it.',
      confirmLabel: 'Set terminal context',
    });
    if (!ok) return;
    try {
      await this.host.invoke('teleport.kube.login', { proxy: this.proxy(), cluster }, null);
      this.toasts.notify(`kubectl in your terminals now points at ${cluster}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  private async pull(runId: string): Promise<void> {
    try {
      const read = await this.host.invoke<KubeStreamRead>('teleport.kube.stream.read', { runId, since: this.next }, null);
      this.next = read.next;
      this.stream.set(read);
      if (read.lines.length) {
        this.lines.update((prev) => {
          const merged = prev.concat(read.lines);
          return merged.length > FOLLOW_BUFFER ? merged.slice(merged.length - FOLLOW_BUFFER) : merged;
        });
      }
      if (!read.running) this.endRun(runId);
    } catch (err) {
      this.error.set(toErrorPayload(err));
      this.endRun(runId);
    }
  }

  private endRun(runId: string): void {
    if (this.running()?.runId === runId) this.running.set(null);
  }
}
