import { z } from 'zod';
import { QuiverError } from '../errors';
import type { KubePreview, KubeRunResult } from './kube';
import { DNS1123_LABEL, DNS1123_SUBDOMAIN, kubePattern } from './kube-patterns';

/**
 * Kubernetes write actions, kept apart from the read-only query catalogue in `kube.ts`.
 *
 * The same rules hold: nobody hands Quiver a kubectl command line. A caller picks one action
 * from this fixed catalogue and fills in its typed parameters; `buildKubeActionArgs` turns that
 * into an argv from a hard-coded template per action, with every flag name from the template and
 * every value validated and in its own argv element. Each action touches exactly one named
 * object (no selectors, no `--all`), and nothing here takes YAML, a patch or a command, so
 * `exec`, `apply`, `edit`, `patch` and `drain` cannot be expressed at all.
 */

// ---------- parameter types ----------

/** Workloads `scale` can resize. */
export const KUBE_SCALABLE = ['deployments', 'statefulsets', 'replicasets'] as const;
/** Workloads with a rollout: restart, undo and set-image. */
export const KUBE_ROLLABLE = ['deployments', 'statefulsets', 'daemonsets'] as const;
/** What `delete` may remove: one pod or one job. */
export const KUBE_DELETABLE = ['pods', 'jobs'] as const;
/** What a port forward may target. */
export const KUBE_FORWARDABLE = ['pods', 'services', 'deployments'] as const;

export const KUBE_REPLICAS_MAX = 1000;
export const KUBE_REVISION_MAX = 1_000_000;
export const KUBE_GRACE_MAX = 3600;

/** `job.batch` names become pod labels, so a DNS-1123 label (63 characters) is the safe bound. */
const JOB_NAME_MAX = 63;

const DOMAIN_COMPONENT = String.raw`(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])`;
const DOMAIN = String.raw`${DOMAIN_COMPONENT}(?:\.${DOMAIN_COMPONENT})*(?::[0-9]{1,5})?`;
const PATH_COMPONENT = String.raw`[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*`;
const TAG = String.raw`[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`;
const DIGEST = String.raw`[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}`;
/**
 * An image reference as the container runtime parses it: an optional registry (`host[:port]/`),
 * lower-case path components, then an optional `:tag` and `@algorithm:digest`. No spaces, no
 * shell characters, and it starts with a letter or digit.
 */
export const IMAGE_REFERENCE = new RegExp(`^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*(?::${TAG})?(?:@${DIGEST})?$`);

const Namespace = kubePattern(DNS1123_LABEL, 63, 'Namespace').describe('Namespace (DNS-1123 label). Required: an action never falls back to a default namespace.');
const Name = kubePattern(DNS1123_SUBDOMAIN, 253, 'Name').describe('Name of the one object the action changes (DNS-1123 subdomain)');
const Node = kubePattern(DNS1123_SUBDOMAIN, 253, 'Node').describe('Node name (DNS-1123 subdomain)');
const Container = kubePattern(DNS1123_LABEL, 63, 'Container').describe('Container whose image is replaced (DNS-1123 label)');
const Image = kubePattern(IMAGE_REFERENCE, 512, 'Image').describe('Image reference: [registry[:port]/]path[:tag][@sha256:digest]');
const JobName = kubePattern(DNS1123_LABEL, JOB_NAME_MAX, 'Job name').describe('Name of the job to create (DNS-1123 label). Omit for <cronjob>-manual-<time>.');
const Replicas = z.number().int().min(0).max(KUBE_REPLICAS_MAX).describe(`Replica count (0-${KUBE_REPLICAS_MAX})`);
const Revision = z.number().int().min(1).max(KUBE_REVISION_MAX).describe('Revision to roll back to (see rollout-history); omit for the previous one');
const Grace = z.number().int().min(0).max(KUBE_GRACE_MAX).describe(`Seconds the pod gets to shut down (0-${KUBE_GRACE_MAX}); omit for its own setting`);
const Port = z.number().int().min(1).max(65535);

// ---------- the catalogue ----------

const p = z.strictObject;

/** One schema per action, discriminated by `action`. Unknown actions and unknown fields are rejected. */
export const KubeActionSchema = z
  .discriminatedUnion('action', [
    p({ action: z.literal('scale'), params: p({ kind: z.enum(KUBE_SCALABLE), name: Name, namespace: Namespace, replicas: Replicas }) }),
    p({ action: z.literal('rollout-restart'), params: p({ kind: z.enum(KUBE_ROLLABLE), name: Name, namespace: Namespace }) }),
    p({ action: z.literal('rollout-undo'), params: p({ kind: z.enum(KUBE_ROLLABLE), name: Name, namespace: Namespace, toRevision: Revision.optional() }) }),
    p({ action: z.literal('rollout-pause'), params: p({ name: Name.describe('Deployment name'), namespace: Namespace }) }),
    p({ action: z.literal('rollout-resume'), params: p({ name: Name.describe('Deployment name'), namespace: Namespace }) }),
    p({ action: z.literal('delete'), params: p({ kind: z.enum(KUBE_DELETABLE), name: Name, namespace: Namespace, gracePeriodSeconds: Grace.optional() }) }),
    p({ action: z.literal('cordon'), params: p({ node: Node }) }),
    p({ action: z.literal('uncordon'), params: p({ node: Node }) }),
    p({ action: z.literal('set-image'), params: p({ kind: z.enum(KUBE_ROLLABLE), name: Name, namespace: Namespace, container: Container, image: Image }) }),
    p({ action: z.literal('cronjob-trigger'), params: p({ name: Name.describe('CronJob name'), namespace: Namespace, jobName: JobName.optional() }) }),
  ])
  .describe('One predefined Kubernetes write action and its parameters');

export type KubeAction = z.infer<typeof KubeActionSchema>;
export type KubeActionId = KubeAction['action'];
export type KubeActionParams<A extends KubeActionId> = Extract<KubeAction, { action: A }>['params'];

/** How the UI edits an action field. */
export type KubeActionFieldKind = 'workload' | 'name' | 'namespace' | 'node' | 'replicas' | 'revision' | 'grace' | 'containerName' | 'image' | 'jobName';

export interface KubeActionField {
  key: string;
  kind: KubeActionFieldKind;
  label: string;
  required: boolean;
  /** For `workload`: the resource types this action accepts. */
  options?: readonly string[];
  help?: string;
}

export interface KubeActionInfo {
  id: KubeActionId;
  title: string;
  description: string;
  /** The fixed kubectl subcommand path this action always starts with. */
  command: readonly string[];
  fields: KubeActionField[];
}

const f = (key: string, kind: KubeActionFieldKind, label: string, required = true, options?: readonly string[]): KubeActionField => ({ key, kind, label, required, ...(options ? { options } : {}) });
const NS = f('namespace', 'namespace', 'Namespace');
const NAME = f('name', 'name', 'Name');

/** The catalogue as data, in picker order. */
export const KUBE_ACTIONS: readonly KubeActionInfo[] = [
  { id: 'scale', title: 'Scale', description: 'kubectl scale <type> <name> --replicas <n>', command: ['scale'], fields: [f('kind', 'workload', 'Type', true, KUBE_SCALABLE), NAME, NS, f('replicas', 'replicas', 'Replicas')] },
  { id: 'rollout-restart', title: 'Restart rollout', description: 'kubectl rollout restart <type> <name>', command: ['rollout', 'restart'], fields: [f('kind', 'workload', 'Type', true, KUBE_ROLLABLE), NAME, NS] },
  {
    id: 'rollout-undo',
    title: 'Undo rollout',
    description: 'kubectl rollout undo <type> <name>, to the previous or a given revision',
    command: ['rollout', 'undo'],
    fields: [f('kind', 'workload', 'Type', true, KUBE_ROLLABLE), NAME, NS, f('toRevision', 'revision', 'To revision', false)],
  },
  { id: 'rollout-pause', title: 'Pause rollout', description: 'kubectl rollout pause deployments <name>', command: ['rollout', 'pause'], fields: [f('name', 'name', 'Deployment'), NS] },
  { id: 'rollout-resume', title: 'Resume rollout', description: 'kubectl rollout resume deployments <name>', command: ['rollout', 'resume'], fields: [f('name', 'name', 'Deployment'), NS] },
  { id: 'delete', title: 'Delete', description: 'kubectl delete <pods|jobs> <name>: one named object, never a selector', command: ['delete'], fields: [f('kind', 'workload', 'Type', true, KUBE_DELETABLE), NAME, NS, f('gracePeriodSeconds', 'grace', 'Grace period (s)', false)] },
  { id: 'cordon', title: 'Cordon node', description: 'kubectl cordon <node>: no new pods are scheduled on it', command: ['cordon'], fields: [f('node', 'node', 'Node')] },
  { id: 'uncordon', title: 'Uncordon node', description: 'kubectl uncordon <node>', command: ['uncordon'], fields: [f('node', 'node', 'Node')] },
  {
    id: 'set-image',
    title: 'Set image',
    description: 'kubectl set image <type> <name> <container>=<image>',
    command: ['set', 'image'],
    fields: [f('kind', 'workload', 'Type', true, KUBE_ROLLABLE), NAME, NS, f('container', 'containerName', 'Container'), f('image', 'image', 'Image')],
  },
  {
    id: 'cronjob-trigger',
    title: 'Trigger CronJob',
    description: 'kubectl create job <job> --from=cronjob/<name>',
    command: ['create', 'job'],
    fields: [f('name', 'name', 'CronJob'), NS, f('jobName', 'jobName', 'Job name', false)],
  },
];

export function kubeActionInfo(id: string): KubeActionInfo | undefined {
  return KUBE_ACTIONS.find((a) => a.id === id);
}

export function isKubeActionId(id: string): id is KubeActionId {
  return KUBE_ACTIONS.some((a) => a.id === id);
}

// ---------- validation and templates ----------

/** Validate an untrusted action (UI form, MCP call, history file). Throws INVALID_INPUT naming each bad field. */
export function parseKubeAction(input: unknown): KubeAction {
  const parsed = KubeActionSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
  throw new QuiverError('INVALID_INPUT', `Invalid Kubernetes action: ${issues}`, parsed.error.issues);
}

/** Field errors keyed by parameter name, for inline form messages. Empty when the action is valid. */
export function kubeActionErrors(input: unknown): Record<string, string> {
  const parsed = KubeActionSchema.safeParse(input);
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] === 'params' && issue.path.length > 1 ? String(issue.path[1]) : issue.path.length ? String(issue.path[issue.path.length - 1]) : 'action';
    out[key] ??= issue.message;
  }
  return out;
}

/** `<cronjob>-manual-<base36 seconds>`, cut so the whole name stays a DNS-1123 label. */
export function defaultJobName(cronjob: string, now: Date = new Date()): string {
  const suffix = `-manual-${Math.floor(now.getTime() / 1000).toString(36)}`;
  return `${cronjob.slice(0, JOB_NAME_MAX - suffix.length).replace(/[-.]+$/, '').replace(/\./g, '-')}${suffix}`;
}

/**
 * The action with every optional value the template needs filled in: today only the job name of
 * `cronjob-trigger`. The host resolves an action once and builds both the preview and the run
 * from the result, so what was previewed is what runs.
 */
export function resolveKubeAction(input: unknown, now: Date = new Date()): KubeAction {
  const action = parseKubeAction(input);
  if (action.action === 'cronjob-trigger' && !action.params.jobName) return parseKubeAction({ ...action, params: { ...action.params, jobName: defaultJobName(action.params.name, now) } });
  return action;
}

/**
 * The kubectl argv (without the program, context and kubeconfig) for one action. Validates
 * first, so it is safe to call with untrusted input; unknown actions throw. A `cronjob-trigger`
 * without a job name throws too: resolve it first with `resolveKubeAction`.
 */
export function buildKubeActionArgs(action: string, params: unknown): string[] {
  const a = parseKubeAction({ action, params });
  switch (a.action) {
    case 'scale': {
      const { kind, name, namespace, replicas } = a.params;
      return ['scale', kind, name, '--namespace', namespace, '--replicas', String(replicas)];
    }
    case 'rollout-restart': {
      const { kind, name, namespace } = a.params;
      return ['rollout', 'restart', kind, name, '--namespace', namespace];
    }
    case 'rollout-undo': {
      const { kind, name, namespace, toRevision } = a.params;
      return ['rollout', 'undo', kind, name, '--namespace', namespace, ...(toRevision !== undefined ? ['--to-revision', String(toRevision)] : [])];
    }
    case 'rollout-pause':
      return ['rollout', 'pause', 'deployments', a.params.name, '--namespace', a.params.namespace];
    case 'rollout-resume':
      return ['rollout', 'resume', 'deployments', a.params.name, '--namespace', a.params.namespace];
    case 'delete': {
      const { kind, name, namespace, gracePeriodSeconds } = a.params;
      return ['delete', kind, name, '--namespace', namespace, ...(gracePeriodSeconds !== undefined ? ['--grace-period', String(gracePeriodSeconds)] : [])];
    }
    case 'cordon':
      return ['cordon', a.params.node];
    case 'uncordon':
      return ['uncordon', a.params.node];
    case 'set-image': {
      const { kind, name, namespace, container, image } = a.params;
      return ['set', 'image', kind, name, `${container}=${image}`, '--namespace', namespace];
    }
    case 'cronjob-trigger': {
      const { name, namespace, jobName } = a.params;
      if (!jobName) throw new QuiverError('INVALID_INPUT', 'Invalid Kubernetes action: params.jobName: resolve the action first so the job name is fixed');
      return ['create', 'job', jobName, `--from=cronjob/${name}`, '--namespace', namespace];
    }
  }
}

/** The object an action changes, as the confirmation names it. */
export interface KubeActionTarget {
  /** Resource type, e.g. `deployments` or `nodes`. */
  kind: string;
  name: string;
  namespace: string | null;
}

export function kubeActionTarget(action: KubeAction): KubeActionTarget {
  switch (action.action) {
    case 'cordon':
    case 'uncordon':
      return { kind: 'nodes', name: action.params.node, namespace: null };
    case 'rollout-pause':
    case 'rollout-resume':
      return { kind: 'deployments', name: action.params.name, namespace: action.params.namespace };
    case 'cronjob-trigger':
      return { kind: 'cronjobs', name: action.params.name, namespace: action.params.namespace };
    default:
      return { kind: action.params.kind, name: action.params.name, namespace: action.params.namespace };
  }
}

/** Actions that remove or stop something: the confirmation also asks for the object's name typed. */
export function isDestructiveKubeAction(action: KubeAction): boolean {
  return action.action === 'delete' || action.action === 'rollout-undo' || action.action === 'cordon' || (action.action === 'scale' && action.params.replicas === 0);
}

// ---------- actions, for agent rules ----------

/** What a `teleport.kube.action` call does, as an agent rule names it (`teleport.kube.action#delete`): the action id, and `scale-to-zero` for a scale to 0 replicas. */
export type KubeRuleAction = KubeActionId | 'scale-to-zero';

export const KUBE_RULE_ACTIONS: readonly KubeRuleAction[] = [
  'scale',
  'scale-to-zero',
  'rollout-restart',
  'rollout-undo',
  'rollout-pause',
  'rollout-resume',
  'delete',
  'cordon',
  'uncordon',
  'set-image',
  'cronjob-trigger',
];

export const KUBE_RULE_ACTION_DESCRIPTIONS: Record<KubeRuleAction, string> = {
  ...(Object.fromEntries(KUBE_ACTIONS.map((a) => [a.id, a.description])) as Record<KubeActionId, string>),
  scale: 'kubectl scale <type> <name> --replicas <n>, n at least 1',
  'scale-to-zero': 'kubectl scale <type> <name> --replicas 0: stops every pod of the workload',
};

/** The rule action of a validated kube action. */
export function kubeRuleAction(action: KubeAction): KubeRuleAction {
  return action.action === 'scale' && action.params.replicas === 0 ? 'scale-to-zero' : action.action;
}

// ---------- port forwards ----------

/** Local ports start above the privileged range. */
export const KUBE_LOCAL_PORT_MIN = 1024;

export const KubePortForwardSpecSchema = z.strictObject({
  kind: z.enum(KUBE_FORWARDABLE).describe('What to forward to: a pod, or a service or deployment (kubectl picks one of its pods)'),
  name: Name.describe('Name of the pod, service or deployment'),
  namespace: Namespace,
  remotePort: Port.describe('Port on the pod or service'),
  localPort: z.number().int().min(KUBE_LOCAL_PORT_MIN).max(65535).optional().describe('Port on 127.0.0.1; omit for a free one'),
});

export type KubePortForwardSpec = z.infer<typeof KubePortForwardSpecSchema>;

/** `kubectl port-forward <kind>/<name> <local>:<remote> --address 127.0.0.1`: only ever on the loopback address. */
export function buildPortForwardArgs(spec: KubePortForwardSpec & { localPort: number }): string[] {
  const parsed = KubePortForwardSpecSchema.required({ localPort: true }).safeParse(spec);
  if (!parsed.success) throw new QuiverError('INVALID_INPUT', `Invalid port forward: ${parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`, parsed.error.issues);
  const s = parsed.data;
  return ['port-forward', `${s.kind}/${s.name}`, `${s.localPort}:${s.remotePort}`, '--address', '127.0.0.1', '--namespace', s.namespace];
}

// ---------- results ----------

/** What `teleport.kube.action` ran and printed: a query result with the action in place of the query. */
export interface KubeActionResult extends Omit<KubeRunResult, 'query' | 'streaming'> {
  action: KubeAction;
}

/** What `teleport.kube.action` would spawn, and what its confirmation has to ask for. */
export interface KubeActionPreview extends KubePreview {
  /** The action with its defaults filled in: pass this to `teleport.kube.action` to run exactly what was previewed. */
  action: KubeAction;
  target: KubeActionTarget;
  /** Delete, scale to 0, rollout undo or cordon: the UI asks for the object's name typed. */
  destructive: boolean;
  /** The cluster is marked protected: the UI asks for the cluster name typed, and agents are refused unless Settings allow them. */
  protected: boolean;
}

export interface KubePortForward {
  id: string;
  proxy: string;
  cluster: string;
  kind: KubePortForwardSpec['kind'];
  name: string;
  namespace: string;
  remotePort: number;
  localPort: number;
  /** `http://127.0.0.1:<localPort>`, for services that speak HTTP. */
  url: string;
  /** The exact command line that runs (display only). */
  command: string;
  pid: number | null;
  /** `exited` stays in the list with its last output until it is stopped (removed). */
  state: 'starting' | 'running' | 'exited';
  exitCode: number | null;
  /** Tail of stdout and stderr. */
  output: string[];
  startedAt: string;
}
