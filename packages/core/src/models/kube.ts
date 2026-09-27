import { z } from 'zod';
import { QuiverError } from '../errors';

/**
 * Read-only Kubernetes queries for clusters reached through Teleport.
 *
 * Nobody, neither the UI nor an agent, ever hands Quiver a kubectl command line. A caller picks
 * one operation from this fixed catalogue and fills in its typed parameters; `buildKubectlArgs`
 * turns that into an argv from a hard-coded template per operation. Every flag name comes from
 * the template, every value is validated and lands in its own argv element, so the only argv
 * that can ever be produced is one of the templates below, and none of them writes.
 */

// ---------- parameter types ----------

/** Resource types a query may name. Secrets are deliberately absent. */
export const KUBE_RESOURCE_TYPES = [
  'pods',
  'deployments',
  'statefulsets',
  'daemonsets',
  'replicasets',
  'services',
  'ingresses',
  'configmaps',
  'jobs',
  'cronjobs',
  'nodes',
  'namespaces',
  'events',
  'persistentvolumeclaims',
  'horizontalpodautoscalers',
] as const;
export type KubeResourceType = (typeof KUBE_RESOURCE_TYPES)[number];

/** Resource types without a namespace: `--namespace` is left out for them. */
export const KUBE_CLUSTER_SCOPED: readonly KubeResourceType[] = ['nodes', 'namespaces'];

export const KUBE_OUTPUTS = ['wide', 'yaml', 'json'] as const;
export type KubeOutput = (typeof KUBE_OUTPUTS)[number];

/** Verbs `auth can-i` may ask about. Asking is read-only whatever the verb. */
export const KUBE_CAN_I_VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection'] as const;

export const KUBE_TAIL_MAX = 100_000;

/** DNS-1123 label: namespaces and container names. */
export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** DNS-1123 subdomain: object names (pods, deployments, nodes, ...). */
export const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

const LABEL_KEY = String.raw`(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?`;
const LABEL_VALUE = String.raw`(?:[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?)?`;
const LABEL_REQUIREMENT = String.raw`${LABEL_KEY}(?:(?:=|==|!=)${LABEL_VALUE}| (?:in|notin) \(${LABEL_VALUE}(?:, ?${LABEL_VALUE})*\))`;
/** `key=value`, `key==value`, `key!=value`, `key in (a,b)`, `key notin (a,b)`, comma separated. Starts with a letter or digit. */
export const LABEL_SELECTOR = new RegExp(`^${LABEL_REQUIREMENT}(?:,${LABEL_REQUIREMENT})*$`);
/** Durations for `--since`: a number and s, m or h. */
export const KUBE_DURATION = /^\d{1,6}[smh]$/;
/** Teleport Kubernetes cluster names as `tsh kube ls` prints them. */
export const KUBE_CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const noDash = (v: string) => !v.startsWith('-');

function pattern(re: RegExp, max: number, what: string) {
  return z
    .string()
    .min(1, `${what} is empty`)
    .max(max, `${what} is longer than ${max} characters`)
    .refine(noDash, `${what} must not start with "-"`)
    .regex(re, `${what} is not valid`);
}

const Namespace = pattern(DNS1123_LABEL, 63, 'Namespace').describe('Namespace (DNS-1123 label). Omit for the default namespace of the cluster.');
const ObjectName = pattern(DNS1123_SUBDOMAIN, 253, 'Name').describe('Object name (DNS-1123 subdomain)');
const PodName = pattern(DNS1123_SUBDOMAIN, 253, 'Pod').describe('Pod name (DNS-1123 subdomain)');
const Container = pattern(DNS1123_LABEL, 63, 'Container').describe('Container name (DNS-1123 label). Defaults to the pod\'s default container.');
const Selector = pattern(LABEL_SELECTOR, 256, 'Label selector').describe('Label selector: key=value, key!=value or key in (a,b), comma separated');
const Resource = z.enum(KUBE_RESOURCE_TYPES).describe('Resource type. Secrets are not available.');
const Output = z.enum(KUBE_OUTPUTS).describe('Output format; omit for the default table');
const AllNamespaces = z.boolean().describe('Across every namespace instead of one');
const Tail = z.number().int().min(1).max(KUBE_TAIL_MAX).describe(`Lines from the end of the log (1-${KUBE_TAIL_MAX})`);
const Since = pattern(KUBE_DURATION, 8, 'Since').describe('Only lines newer than this, e.g. 30s, 15m, 2h');

// ---------- the catalogue ----------

const p = z.strictObject;

/** One schema per operation, discriminated by `operation`. Unknown operations and unknown fields are rejected. */
export const KubeQuerySchema = z
  .discriminatedUnion('operation', [
    p({ operation: z.literal('list'), params: p({ resource: Resource, namespace: Namespace.optional(), allNamespaces: AllNamespaces.optional(), selector: Selector.optional(), output: Output.optional() }) }),
    p({ operation: z.literal('get'), params: p({ resource: Resource, name: ObjectName, namespace: Namespace.optional(), output: Output.optional() }) }),
    p({ operation: z.literal('describe'), params: p({ resource: Resource, name: ObjectName, namespace: Namespace.optional() }) }),
    p({
      operation: z.literal('logs'),
      params: p({
        pod: PodName,
        namespace: Namespace.optional(),
        container: Container.optional(),
        tail: Tail.optional(),
        since: Since.optional(),
        previous: z.boolean().optional().describe('Logs of the previous, crashed container instance'),
        timestamps: z.boolean().optional().describe('Prefix each line with its timestamp'),
      }),
    }),
    p({ operation: z.literal('logs-follow'), params: p({ pod: PodName, namespace: Namespace.optional(), container: Container.optional(), tail: Tail.optional(), since: Since.optional(), timestamps: z.boolean().optional() }) }),
    p({ operation: z.literal('events'), params: p({ namespace: Namespace.optional(), allNamespaces: AllNamespaces.optional() }) }),
    p({ operation: z.literal('top-pods'), params: p({ namespace: Namespace.optional(), allNamespaces: AllNamespaces.optional(), selector: Selector.optional(), containers: z.boolean().optional().describe('Per container instead of per pod') }) }),
    p({ operation: z.literal('top-nodes'), params: p({ selector: Selector.optional() }) }),
    p({ operation: z.literal('rollout-status'), params: p({ deployment: ObjectName, namespace: Namespace.optional() }) }),
    p({ operation: z.literal('rollout-history'), params: p({ deployment: ObjectName, namespace: Namespace.optional() }) }),
    p({ operation: z.literal('namespaces'), params: p({ output: Output.optional() }) }),
    p({ operation: z.literal('api-resources'), params: p({}) }),
    p({ operation: z.literal('version'), params: p({}) }),
    p({
      operation: z.literal('can-i'),
      params: p({ verb: z.enum(KUBE_CAN_I_VERBS), resource: Resource, name: ObjectName.optional(), namespace: Namespace.optional(), allNamespaces: AllNamespaces.optional() }),
    }),
  ])
  .superRefine((q, ctx) => {
    const params = q.params as { namespace?: string; allNamespaces?: boolean };
    if (params.namespace && params.allNamespaces) ctx.addIssue({ code: 'custom', path: ['params', 'allNamespaces'], message: 'Pick a namespace or all namespaces, not both' });
  })
  .describe('One predefined read-only operation and its parameters');

export type KubeQuery = z.infer<typeof KubeQuerySchema>;
export type KubeOperation = KubeQuery['operation'];
export type KubeParams<O extends KubeOperation> = Extract<KubeQuery, { operation: O }>['params'];

/** Every field an operation form can show, and how the UI edits it. */
export type KubeFieldKind = 'resource' | 'name' | 'namespace' | 'allNamespaces' | 'pod' | 'container' | 'selector' | 'tail' | 'since' | 'output' | 'flag' | 'verb' | 'deployment';

export interface KubeField {
  key: string;
  kind: KubeFieldKind;
  label: string;
  required: boolean;
  help?: string;
}

export interface KubeOperationInfo {
  id: KubeOperation;
  title: string;
  description: string;
  /** The fixed kubectl subcommand path this operation always starts with. */
  command: readonly string[];
  /** Runs until stopped, output is read incrementally. */
  streaming: boolean;
  fields: KubeField[];
}

const f = (key: string, kind: KubeFieldKind, label: string, required = false, help?: string): KubeField => ({ key, kind, label, required, help });
const NS = f('namespace', 'namespace', 'Namespace');
const ALL_NS = f('allNamespaces', 'allNamespaces', 'All namespaces');

/** The catalogue as data, in picker order. */
export const KUBE_OPERATIONS: readonly KubeOperationInfo[] = [
  { id: 'list', title: 'List resources', description: 'kubectl get <type>', command: ['get'], streaming: false, fields: [f('resource', 'resource', 'Type', true), NS, ALL_NS, f('selector', 'selector', 'Label selector'), f('output', 'output', 'Output')] },
  { id: 'get', title: 'Get one resource', description: 'kubectl get <type> <name>', command: ['get'], streaming: false, fields: [f('resource', 'resource', 'Type', true), f('name', 'name', 'Name', true), NS, f('output', 'output', 'Output')] },
  { id: 'describe', title: 'Describe', description: 'kubectl describe <type> <name>', command: ['describe'], streaming: false, fields: [f('resource', 'resource', 'Type', true), f('name', 'name', 'Name', true), NS] },
  {
    id: 'logs',
    title: 'Pod logs',
    description: 'kubectl logs <pod>',
    command: ['logs'],
    streaming: false,
    fields: [f('pod', 'pod', 'Pod', true), NS, f('container', 'container', 'Container'), f('tail', 'tail', 'Tail'), f('since', 'since', 'Since'), f('previous', 'flag', 'Previous instance'), f('timestamps', 'flag', 'Timestamps')],
  },
  { id: 'logs-follow', title: 'Follow logs', description: 'kubectl logs -f <pod>, streams until stopped', command: ['logs'], streaming: true, fields: [f('pod', 'pod', 'Pod', true), NS, f('container', 'container', 'Container'), f('tail', 'tail', 'Tail'), f('since', 'since', 'Since'), f('timestamps', 'flag', 'Timestamps')] },
  { id: 'events', title: 'Events', description: 'kubectl get events, oldest first', command: ['get', 'events'], streaming: false, fields: [NS, ALL_NS] },
  { id: 'top-pods', title: 'Top pods', description: 'kubectl top pods (needs metrics-server)', command: ['top', 'pods'], streaming: false, fields: [NS, ALL_NS, f('selector', 'selector', 'Label selector'), f('containers', 'flag', 'Per container')] },
  { id: 'top-nodes', title: 'Top nodes', description: 'kubectl top nodes (needs metrics-server)', command: ['top', 'nodes'], streaming: false, fields: [f('selector', 'selector', 'Label selector')] },
  { id: 'rollout-status', title: 'Rollout status', description: 'kubectl rollout status deployment <name>', command: ['rollout', 'status'], streaming: false, fields: [f('deployment', 'deployment', 'Deployment', true), NS] },
  { id: 'rollout-history', title: 'Rollout history', description: 'kubectl rollout history deployment <name>', command: ['rollout', 'history'], streaming: false, fields: [f('deployment', 'deployment', 'Deployment', true), NS] },
  { id: 'namespaces', title: 'List namespaces', description: 'kubectl get namespaces', command: ['get', 'namespaces'], streaming: false, fields: [f('output', 'output', 'Output')] },
  { id: 'api-resources', title: 'API resources', description: 'kubectl api-resources', command: ['api-resources'], streaming: false, fields: [] },
  { id: 'version', title: 'Version', description: 'kubectl version', command: ['version'], streaming: false, fields: [] },
  {
    id: 'can-i',
    title: 'Can I?',
    description: 'kubectl auth can-i <verb> <type>',
    command: ['auth', 'can-i'],
    streaming: false,
    fields: [f('verb', 'verb', 'Verb', true), f('resource', 'resource', 'Type', true), f('name', 'name', 'Name'), NS, ALL_NS],
  },
];

export function kubeOperationInfo(id: string): KubeOperationInfo | undefined {
  return KUBE_OPERATIONS.find((o) => o.id === id);
}

// ---------- validation and templates ----------

/** Validate an untrusted query (UI form, MCP call, history file). Throws INVALID_INPUT naming each bad field. */
export function parseKubeQuery(input: unknown): KubeQuery {
  const parsed = KubeQuerySchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
  throw new QuiverError('INVALID_INPUT', `Invalid Kubernetes query: ${issues}`, parsed.error.issues);
}

/** Field errors keyed by parameter name, for inline form messages. Empty when the query is valid. */
export function kubeQueryErrors(input: unknown): Record<string, string> {
  const parsed = KubeQuerySchema.safeParse(input);
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0] === 'params' && issue.path.length > 1 ? String(issue.path[1]) : issue.path.length ? String(issue.path[issue.path.length - 1]) : 'operation';
    out[key] ??= issue.message;
  }
  return out;
}

const namespaced = (namespace: string | undefined, allNamespaces: boolean | undefined): string[] => (allNamespaces ? ['--all-namespaces'] : namespace ? ['--namespace', namespace] : []);

/**
 * The kubectl argv (without the program, context and kubeconfig) for one operation.
 * Validates first, so it is safe to call with untrusted input; unknown operations throw.
 */
export function buildKubectlArgs(operation: string, params: unknown): string[] {
  const q = parseKubeQuery({ operation, params });
  switch (q.operation) {
    case 'list': {
      const { resource, namespace, allNamespaces, selector, output } = q.params;
      const scoped = KUBE_CLUSTER_SCOPED.includes(resource) ? [] : namespaced(namespace, allNamespaces);
      return ['get', resource, ...scoped, ...(selector ? ['--selector', selector] : []), ...(output ? ['--output', output] : [])];
    }
    case 'get': {
      const { resource, name, namespace, output } = q.params;
      const scoped = KUBE_CLUSTER_SCOPED.includes(resource) ? [] : namespaced(namespace, false);
      return ['get', resource, name, ...scoped, ...(output ? ['--output', output] : [])];
    }
    case 'describe': {
      const { resource, name, namespace } = q.params;
      return ['describe', resource, name, ...(KUBE_CLUSTER_SCOPED.includes(resource) ? [] : namespaced(namespace, false))];
    }
    case 'logs': {
      const { pod, namespace, container, tail, since, previous, timestamps } = q.params;
      return [
        'logs',
        pod,
        ...namespaced(namespace, false),
        ...(container ? ['--container', container] : []),
        ...(tail !== undefined ? ['--tail', String(tail)] : []),
        ...(since ? ['--since', since] : []),
        ...(previous ? ['--previous'] : []),
        ...(timestamps ? ['--timestamps'] : []),
      ];
    }
    case 'logs-follow': {
      const { pod, namespace, container, tail, since, timestamps } = q.params;
      return [
        'logs',
        pod,
        '--follow',
        ...namespaced(namespace, false),
        ...(container ? ['--container', container] : []),
        ...(tail !== undefined ? ['--tail', String(tail)] : []),
        ...(since ? ['--since', since] : []),
        ...(timestamps ? ['--timestamps'] : []),
      ];
    }
    case 'events':
      return ['get', 'events', ...namespaced(q.params.namespace, q.params.allNamespaces), '--sort-by', '.lastTimestamp'];
    case 'top-pods': {
      const { namespace, allNamespaces, selector, containers } = q.params;
      return ['top', 'pods', ...namespaced(namespace, allNamespaces), ...(selector ? ['--selector', selector] : []), ...(containers ? ['--containers'] : [])];
    }
    case 'top-nodes':
      return ['top', 'nodes', ...(q.params.selector ? ['--selector', q.params.selector] : [])];
    case 'rollout-status':
      return ['rollout', 'status', 'deployment', q.params.deployment, ...namespaced(q.params.namespace, false), '--watch=false'];
    case 'rollout-history':
      return ['rollout', 'history', 'deployment', q.params.deployment, ...namespaced(q.params.namespace, false)];
    case 'namespaces':
      return ['get', 'namespaces', ...(q.params.output ? ['--output', q.params.output] : [])];
    case 'api-resources':
      return ['api-resources'];
    case 'version':
      return ['version'];
    case 'can-i': {
      const { verb, resource, name, namespace, allNamespaces } = q.params;
      const scoped = KUBE_CLUSTER_SCOPED.includes(resource) ? [] : namespaced(namespace, allNamespaces);
      return ['auth', 'can-i', verb, resource, ...(name ? [name] : []), ...scoped];
    }
  }
}

/** kubectl subcommands that change a cluster. No template may ever start with one. */
export const KUBE_WRITE_VERBS = [
  'apply',
  'create',
  'delete',
  'edit',
  'patch',
  'replace',
  'scale',
  'autoscale',
  'set',
  'label',
  'annotate',
  'expose',
  'run',
  'exec',
  'attach',
  'cp',
  'port-forward',
  'proxy',
  'debug',
  'drain',
  'cordon',
  'uncordon',
  'taint',
  'certificate',
  'restart',
  'undo',
  'pause',
  'resume',
  'rollback',
  'kustomize',
  'plugin',
  'config',
  'wait',
] as const;

export interface CommandLineOptions {
  /** PowerShell quoting (`& 'C:\\Program Files\\...' ...`, `$env:NAME='...'; `) instead of POSIX sh. */
  windows?: boolean;
  /** Environment variables the process gets on top of the app's own. */
  env?: Record<string, string>;
}

/**
 * The exact argv as a copyable command line for the platform's usual shell. Display only:
 * Quiver spawns the argv array without a shell and never parses this text back.
 */
export function formatCommandLine(argv: readonly string[], options: CommandLineOptions = {}): string {
  const safe = options.windows ? /^[A-Za-z0-9_./:=,@%+~\\-]+$/ : /^[A-Za-z0-9_./:=,@%+~-]+$/;
  // A `~` inside a word is literal in both shells (Windows short names like `RUNNER~1`), but
  // sh expands one that starts a word or follows `=` or `:`, so those still get quoted.
  const expandsTilde = /^~|[=:]~/;
  const quote = (a: string) => (a !== '' && safe.test(a) && !expandsTilde.test(a) ? a : options.windows ? `'${a.replace(/'/g, "''")}'` : `'${a.replace(/'/g, `'\\''`)}'`);
  const env = Object.entries(options.env ?? {});
  if (options.windows) {
    const [program, ...rest] = argv.map(quote);
    const call = [program?.startsWith("'") ? `& ${program}` : program, ...rest].join(' ');
    return [...env.map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}';`), call].join(' ');
  }
  return [...env.map(([k, v]) => `${k}=${quote(v)}`), ...argv.map(quote)].join(' ');
}

// ---------- results, history ----------

export interface KubeRunResult {
  runId: string;
  proxy: string;
  cluster: string;
  query: KubeQuery;
  /** The exact command line that ran, program and every flag included (display only). */
  command: string;
  /** The exact argv that was spawned, without a shell. */
  argv: string[];
  /** When this run first had to prepare the private kubeconfig: that `tsh kube login` command line, else null. */
  setup: string | null;
  stdout: string;
  stderr: string;
  /** Null while a stream is running, or when the process was killed. */
  exitCode: number | null;
  durationMs: number;
  /** Output was longer than the cap and was cut. */
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** `logs-follow`: the process keeps running; read it with teleport.kube.stream.read and stop it with teleport.kube.cancel. */
  streaming: boolean;
  historyId: string;
  startedAt: string;
}

/** What `teleport.kube.query` would spawn for a query, before running it. */
export interface KubePreview {
  command: string;
  argv: string[];
  /** False until the private kubeconfig exists: the context is then tsh's default name, confirmed by the first run. */
  contextConfirmed: boolean;
  /** The one-time `tsh kube login` that the first run does first, or null when it already ran. */
  setup: string | null;
}

export interface KubeStreamRead {
  runId: string;
  /** Lines after `since`, oldest first. */
  lines: string[];
  /** Pass back as `since` to get only newer lines. */
  next: number;
  /** Lines that fell out of the capped buffer before they were read. */
  dropped: number;
  running: boolean;
  exitCode: number | null;
  stderr: string;
  durationMs: number;
}

export const KubeHistoryEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  proxy: z.string().min(1).max(255),
  cluster: z.string().max(253).regex(KUBE_CLUSTER_NAME),
  query: KubeQuerySchema,
  at: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  pinned: z.boolean().default(false),
  caller: z.enum(['ui', 'mcp', 'cli', 'system']).default('ui'),
});

export type KubeHistoryEntry = z.infer<typeof KubeHistoryEntrySchema>;

export const KUBE_HISTORY_MAX = 200;

/**
 * Load history from an untrusted file: every entry goes through the same query validation as
 * a live call, so a hand-edited file cannot smuggle arguments in. Returns the valid entries and
 * how many were dropped.
 */
export function sanitizeKubeHistory(raw: unknown): { entries: KubeHistoryEntry[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
  const entries: KubeHistoryEntry[] = [];
  let dropped = 0;
  for (const item of list) {
    const parsed = KubeHistoryEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else dropped++;
  }
  return { entries, dropped };
}

/** Newest first, capped; pinned entries are kept even beyond the cap. */
export function addKubeHistory(entries: KubeHistoryEntry[], entry: KubeHistoryEntry, max = KUBE_HISTORY_MAX): KubeHistoryEntry[] {
  const next = [entry, ...entries.filter((e) => e.id !== entry.id)];
  let unpinned = 0;
  return next.filter((e) => e.pinned || ++unpinned <= max);
}

/** The namespace last used on a cluster, remembered from its history. */
export function lastKubeNamespace(entries: KubeHistoryEntry[], proxy: string, cluster: string): string | null {
  for (const e of entries) {
    if (e.proxy !== proxy || e.cluster !== cluster) continue;
    const ns = (e.query.params as { namespace?: string }).namespace;
    if (ns) return ns;
  }
  return null;
}

// ---------- output parsers for pickers ----------

/**
 * The candidate closest to a misspelt value (swapped, missing, extra or wrong characters), or
 * null when nothing is close. kubectl answers a query in a namespace that does not exist with
 * "No resources found" and exit 0, so the form uses this to catch typos before they run.
 */
export function closestName(value: string, candidates: readonly string[]): string | null {
  if (!value || candidates.includes(value)) return null;
  // Optimal string alignment distance: Levenshtein plus adjacent transpositions.
  const distance = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  let best: { name: string; score: number } | null = null;
  for (const name of candidates) {
    const score = distance(value, name);
    if (score <= Math.max(1, Math.floor(value.length / 4)) && (!best || score < best.score)) best = { name, score };
  }
  return best?.name ?? null;
}

/** First column of a kubectl table (NAME), header skipped. */
export function parseKubectlNames(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const body = /^NAME\b/i.test(lines[0].trim()) ? lines.slice(1) : lines;
  return body.map((l) => l.trim().split(/\s+/)[0]).filter((n) => DNS1123_SUBDOMAIN.test(n));
}

/** Container names from `kubectl get pods <name> -o json`: init containers after the regular ones. */
export function parsePodContainers(stdout: string): string[] {
  try {
    const pod = JSON.parse(stdout) as { spec?: { containers?: { name?: unknown }[]; initContainers?: { name?: unknown }[] } };
    const names = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])].map((c) => c.name).filter((n): n is string => typeof n === 'string' && DNS1123_LABEL.test(n));
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/** `current-context` of a kubeconfig written by `tsh kube login`. */
export function kubeconfigCurrentContext(yaml: string): string | null {
  const match = /^current-context:\s*["']?([^"'\s]+)["']?\s*$/m.exec(yaml);
  return match && /^[A-Za-z0-9][A-Za-z0-9._@:/-]*$/.test(match[1]) ? match[1] : null;
}
