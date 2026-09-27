import { describe, expect, it } from 'vitest';
import {
  KUBE_CAN_I_VERBS,
  KUBE_HISTORY_MAX,
  KUBE_OPERATIONS,
  KUBE_OUTPUTS,
  KUBE_RESOURCE_TYPES,
  KUBE_WRITE_VERBS,
  KubeQuerySchema,
  addKubeHistory,
  buildKubectlArgs,
  formatKubectlCommand,
  kubeQueryErrors,
  kubeconfigCurrentContext,
  lastKubeNamespace,
  parseKubectlNames,
  parsePodContainers,
  sanitizeKubeHistory,
  type KubeHistoryEntry,
} from './kube';

const build = (operation: string, params: Record<string, unknown> = {}) => buildKubectlArgs(operation, params);
const rejects = (operation: string, params: Record<string, unknown>) => expect(() => build(operation, params)).toThrow(/Invalid Kubernetes query/);

describe('buildKubectlArgs: exact argv per operation', () => {
  it('list', () => {
    expect(build('list', { resource: 'pods' })).toEqual(['get', 'pods']);
    expect(build('list', { resource: 'pods', namespace: 'payments', selector: 'app=api', output: 'wide' })).toEqual(['get', 'pods', '--namespace', 'payments', '--selector', 'app=api', '--output', 'wide']);
    expect(build('list', { resource: 'deployments', allNamespaces: true })).toEqual(['get', 'deployments', '--all-namespaces']);
    expect(build('list', { resource: 'nodes', namespace: 'ignored', output: 'json' })).toEqual(['get', 'nodes', '--output', 'json']);
  });

  it('get', () => {
    expect(build('get', { resource: 'services', name: 'api', namespace: 'payments', output: 'yaml' })).toEqual(['get', 'services', 'api', '--namespace', 'payments', '--output', 'yaml']);
    expect(build('get', { resource: 'nodes', name: 'ip-10-0-0-1.ec2.internal' })).toEqual(['get', 'nodes', 'ip-10-0-0-1.ec2.internal']);
  });

  it('describe', () => {
    expect(build('describe', { resource: 'pods', name: 'api-7d9f-abc12', namespace: 'payments' })).toEqual(['describe', 'pods', 'api-7d9f-abc12', '--namespace', 'payments']);
  });

  it('logs', () => {
    expect(build('logs', { pod: 'api-1' })).toEqual(['logs', 'api-1']);
    expect(build('logs', { pod: 'api-1', namespace: 'payments', container: 'sidecar', tail: 50, since: '15m', previous: true, timestamps: true })).toEqual([
      'logs',
      'api-1',
      '--namespace',
      'payments',
      '--container',
      'sidecar',
      '--tail',
      '50',
      '--since',
      '15m',
      '--previous',
      '--timestamps',
    ]);
    expect(build('logs', { pod: 'api-1', previous: false, timestamps: false })).toEqual(['logs', 'api-1']);
  });

  it('logs-follow', () => {
    expect(build('logs-follow', { pod: 'api-1', namespace: 'payments', tail: 100 })).toEqual(['logs', 'api-1', '--follow', '--namespace', 'payments', '--tail', '100']);
  });

  it('events', () => {
    expect(build('events', { namespace: 'payments' })).toEqual(['get', 'events', '--namespace', 'payments', '--sort-by', '.lastTimestamp']);
    expect(build('events', { allNamespaces: true })).toEqual(['get', 'events', '--all-namespaces', '--sort-by', '.lastTimestamp']);
  });

  it('top', () => {
    expect(build('top-pods', { namespace: 'payments', containers: true })).toEqual(['top', 'pods', '--namespace', 'payments', '--containers']);
    expect(build('top-nodes', {})).toEqual(['top', 'nodes']);
    expect(build('top-nodes', { selector: 'pool in (a,b)' })).toEqual(['top', 'nodes', '--selector', 'pool in (a,b)']);
  });

  it('rollout', () => {
    expect(build('rollout-status', { deployment: 'api', namespace: 'payments' })).toEqual(['rollout', 'status', 'deployment', 'api', '--namespace', 'payments', '--watch=false']);
    expect(build('rollout-history', { deployment: 'api' })).toEqual(['rollout', 'history', 'deployment', 'api']);
  });

  it('namespaces, api-resources, version', () => {
    expect(build('namespaces')).toEqual(['get', 'namespaces']);
    expect(build('namespaces', { output: 'json' })).toEqual(['get', 'namespaces', '--output', 'json']);
    expect(build('api-resources')).toEqual(['api-resources']);
    expect(build('version')).toEqual(['version']);
  });

  it('can-i', () => {
    expect(build('can-i', { verb: 'delete', resource: 'pods', namespace: 'payments' })).toEqual(['auth', 'can-i', 'delete', 'pods', '--namespace', 'payments']);
    expect(build('can-i', { verb: 'get', resource: 'deployments', name: 'api', allNamespaces: true })).toEqual(['auth', 'can-i', 'get', 'deployments', 'api', '--all-namespaces']);
  });
});

describe('buildKubectlArgs: rejects anything outside the catalogue', () => {
  it('unknown operations', () => {
    for (const op of ['exec', 'delete', 'apply', 'raw', 'get pods', '', 'LIST', '__proto__']) rejects(op, {});
  });

  it('unknown fields, including flag-shaped ones', () => {
    rejects('list', { resource: 'pods', args: ['--as=admin'] });
    rejects('list', { resource: 'pods', flags: '--kubeconfig=/tmp/x' });
    rejects('version', { output: 'json' });
    rejects('api-resources', { extra: true });
    expect(KubeQuerySchema.safeParse({ operation: 'version', params: {}, command: 'kubectl delete ns x' }).success).toBe(false);
  });

  it('secrets are not a resource type', () => {
    expect(KUBE_RESOURCE_TYPES as readonly string[]).not.toContain('secrets');
    rejects('list', { resource: 'secrets' });
    rejects('get', { resource: 'secret', name: 'db-password' });
    rejects('describe', { resource: 'secrets', name: 'x' });
    rejects('can-i', { verb: 'get', resource: 'secrets' });
  });

  it('leading dashes in every string field', () => {
    rejects('get', { resource: 'pods', name: '-oyaml' });
    rejects('get', { resource: 'pods', name: '--all' });
    rejects('list', { resource: 'pods', namespace: '-n' });
    rejects('list', { resource: 'pods', selector: '-l=x' });
    rejects('logs', { pod: '--help' });
    rejects('logs', { pod: 'api', container: '-c' });
    rejects('logs', { pod: 'api', since: '-1h' });
    rejects('rollout-status', { deployment: '--watch' });
  });

  it('spaces, shell characters and control characters', () => {
    const bad = ['api pod', 'api;rm -rf /', 'api&&x', 'api|x', '$(id)', '`id`', 'api\nx', "api'x", 'api"x', 'api>x', 'a*', '../etc', 'API', 'api/x', 'api\\x', 'api\tx'];
    for (const name of bad) {
      rejects('get', { resource: 'pods', name });
      rejects('logs', { pod: name });
      rejects('list', { resource: 'pods', namespace: name });
    }
    for (const selector of ['app=api;id', 'app=$(id)', 'app=api && x', 'app in (a b)', 'app=a\nb', '=x', 'app=api,', 'app in ()x']) rejects('list', { resource: 'pods', selector });
  });

  it('accepts the selector forms', () => {
    for (const selector of ['app=api', 'app==api', 'app!=api', 'app in (a,b)', 'app notin (a, b)', 'app.kubernetes.io/name=api,tier!=db', 'app=']) {
      expect(build('list', { resource: 'pods', selector })).toContain(selector);
    }
  });

  it('numeric and duration ranges', () => {
    rejects('logs', { pod: 'api', tail: 0 });
    rejects('logs', { pod: 'api', tail: -1 });
    rejects('logs', { pod: 'api', tail: 1.5 });
    rejects('logs', { pod: 'api', tail: 1_000_000 });
    rejects('logs', { pod: 'api', tail: '10' });
    for (const since of ['10', '10d', '1h30m', 'h', '1 h', '1234567s']) rejects('logs', { pod: 'api', since });
    expect(build('logs', { pod: 'api', since: '2h' })).toContain('2h');
  });

  it('enums and booleans are strict', () => {
    rejects('list', { resource: 'pods', output: 'jsonpath={.items}' });
    rejects('list', { resource: 'pods', output: 'go-template' });
    rejects('list', { resource: 'pods', allNamespaces: 'true' });
    rejects('can-i', { verb: 'escalate', resource: 'pods' });
    rejects('can-i', { verb: '*', resource: 'pods' });
  });

  it('namespace and all namespaces together', () => {
    rejects('list', { resource: 'pods', namespace: 'a', allNamespaces: true });
  });

  it('length limits', () => {
    rejects('list', { resource: 'pods', namespace: 'a'.repeat(64) });
    rejects('get', { resource: 'pods', name: 'a'.repeat(254) });
  });
});

/** Every combination of the enum-valued parameters, plus the optional flags, for each operation. */
function samples(): { operation: string; params: Record<string, unknown> }[] {
  const out: { operation: string; params: Record<string, unknown> }[] = [];
  const outputs = [undefined, ...KUBE_OUTPUTS];
  for (const resource of KUBE_RESOURCE_TYPES) {
    for (const output of outputs) {
      out.push({ operation: 'list', params: { resource, namespace: 'ns', selector: 'a=b', output } });
      out.push({ operation: 'list', params: { resource, allNamespaces: true, output } });
      out.push({ operation: 'get', params: { resource, name: 'x', namespace: 'ns', output } });
    }
    out.push({ operation: 'describe', params: { resource, name: 'x', namespace: 'ns' } });
    for (const verb of KUBE_CAN_I_VERBS) {
      out.push({ operation: 'can-i', params: { verb, resource, name: 'x', namespace: 'ns' } });
      out.push({ operation: 'can-i', params: { verb, resource, allNamespaces: true } });
    }
  }
  out.push({ operation: 'logs', params: { pod: 'p', namespace: 'ns', container: 'c', tail: 5, since: '1m', previous: true, timestamps: true } });
  out.push({ operation: 'logs-follow', params: { pod: 'p', namespace: 'ns', container: 'c', tail: 5, since: '1m', timestamps: true } });
  out.push({ operation: 'events', params: { namespace: 'ns' } }, { operation: 'events', params: { allNamespaces: true } });
  out.push({ operation: 'top-pods', params: { namespace: 'ns', selector: 'a=b', containers: true } }, { operation: 'top-nodes', params: { selector: 'a=b' } });
  out.push({ operation: 'rollout-status', params: { deployment: 'd', namespace: 'ns' } }, { operation: 'rollout-history', params: { deployment: 'd', namespace: 'ns' } });
  for (const output of outputs) out.push({ operation: 'namespaces', params: { output } });
  out.push({ operation: 'api-resources', params: {} }, { operation: 'version', params: {} });
  return out.map((s) => ({ ...s, params: Object.fromEntries(Object.entries(s.params).filter(([, v]) => v !== undefined)) }));
}

describe('no template can write', () => {
  const all = samples();

  it('covers every operation in the catalogue', () => {
    expect(new Set(all.map((s) => s.operation))).toEqual(new Set(KUBE_OPERATIONS.map((o) => o.id)));
  });

  it('every argv starts with the operation\'s read-only command path', () => {
    const readOnly = new Set(['get', 'describe', 'logs', 'top pods', 'top nodes', 'rollout status', 'rollout history', 'api-resources', 'version', 'auth can-i', 'get events', 'get namespaces']);
    for (const { operation, params } of all) {
      const argv = build(operation, params);
      const info = KUBE_OPERATIONS.find((o) => o.id === operation)!;
      expect(argv.slice(0, info.command.length)).toEqual([...info.command]);
      expect(readOnly.has(info.command.join(' '))).toBe(true);
    }
  });

  it('no write verb appears anywhere, except as the question of auth can-i', () => {
    const writes = new Set<string>(KUBE_WRITE_VERBS);
    for (const { operation, params } of all) {
      const argv = build(operation, params);
      argv.forEach((arg, i) => {
        if (operation === 'can-i' && i === 2) return;
        expect(writes.has(arg), `${operation}: ${argv.join(' ')}`).toBe(false);
      });
    }
  });

  it('only template flags, and only values the caller validated', () => {
    const templateFlags = new Set(['--namespace', '--all-namespaces', '--selector', '--output', '--container', '--tail', '--since', '--previous', '--timestamps', '--follow', '--sort-by', '--containers', '--watch=false']);
    for (const { operation, params } of all) {
      for (const arg of build(operation, params)) if (arg.startsWith('-')) expect(templateFlags.has(arg), arg).toBe(true);
    }
  });

  it('never targets another context, kubeconfig, server or identity', () => {
    for (const { operation, params } of all) {
      const joined = build(operation, params).join(' ');
      expect(joined).not.toMatch(/--(context|kubeconfig|server|as|as-group|token|user|cluster|raw)\b/);
    }
  });
});

describe('form helpers', () => {
  it('field errors are keyed by parameter', () => {
    expect(kubeQueryErrors({ operation: 'logs', params: { pod: '-x', tail: 0 } })).toMatchObject({ pod: expect.stringContaining('-'), tail: expect.any(String) });
    expect(kubeQueryErrors({ operation: 'logs', params: { pod: 'ok' } })).toEqual({});
  });

  it('display command quotes what needs quoting', () => {
    expect(formatKubectlCommand(['get', 'pods', '--selector', 'app in (a,b)'])).toBe("kubectl get pods --selector 'app in (a,b)'");
    expect(formatKubectlCommand(['get', 'events', '--sort-by', '.lastTimestamp'])).toBe('kubectl get events --sort-by .lastTimestamp');
  });

  it('parses picker data', () => {
    expect(parseKubectlNames('NAME              READY   STATUS\napi-7d9f-abc12   2/2     Running\nworker-1   1/1   Running\n')).toEqual(['api-7d9f-abc12', 'worker-1']);
    expect(parseKubectlNames('No resources found in x namespace.\n')).toEqual([]);
    expect(parsePodContainers(JSON.stringify({ spec: { containers: [{ name: 'api' }, { name: 'sidecar' }], initContainers: [{ name: 'migrate' }, { name: '-bad' }] } }))).toEqual(['api', 'sidecar', 'migrate']);
    expect(parsePodContainers('nope')).toEqual([]);
    expect(kubeconfigCurrentContext('apiVersion: v1\ncurrent-context: smoke.teleport.local-dev-eks\nkind: Config\n')).toBe('smoke.teleport.local-dev-eks');
    expect(kubeconfigCurrentContext('current-context: "a b"\n')).toBeNull();
  });
});

describe('history', () => {
  const entry = (id: string, extra: Partial<KubeHistoryEntry> = {}): KubeHistoryEntry => ({
    id,
    proxy: 'a:443',
    cluster: 'dev-eks',
    query: { operation: 'list', params: { resource: 'pods', namespace: 'payments' } },
    at: '2026-09-27T10:00:00Z',
    exitCode: 0,
    durationMs: 12,
    pinned: false,
    caller: 'ui',
    ...extra,
  });

  it('replays through the same validation: tampered entries are dropped', () => {
    const tampered = [
      entry('ok'),
      { ...entry('flag'), query: { operation: 'list', params: { resource: 'pods', namespace: '--kubeconfig=/etc/x' } } },
      { ...entry('op'), query: { operation: 'exec', params: { pod: 'x' } } },
      { ...entry('field'), query: { operation: 'version', params: { args: ['delete'] } } },
      { ...entry('secret'), query: { operation: 'get', params: { resource: 'secrets', name: 'x' } } },
      { ...entry('cluster'), cluster: '--insecure' },
      'garbage',
    ];
    const { entries, dropped } = sanitizeKubeHistory({ entries: tampered });
    expect(entries.map((e) => e.id)).toEqual(['ok']);
    expect(dropped).toBe(6);
    expect(sanitizeKubeHistory(null)).toEqual({ entries: [], dropped: 0 });
  });

  it('caps unpinned entries and keeps pinned ones', () => {
    let list: KubeHistoryEntry[] = [entry('fav', { pinned: true })];
    for (let i = 0; i < KUBE_HISTORY_MAX + 20; i++) list = addKubeHistory(list, entry(`e${i}`));
    expect(list.length).toBe(KUBE_HISTORY_MAX + 1);
    expect(list[0].id).toBe(`e${KUBE_HISTORY_MAX + 19}`);
    expect(list.some((e) => e.id === 'fav')).toBe(true);
  });

  it('remembers the last namespace per cluster', () => {
    const list = [entry('1', { query: { operation: 'version', params: {} } }), entry('2'), entry('3', { cluster: 'prod-eks', query: { operation: 'events', params: { namespace: 'other' } } })];
    expect(lastKubeNamespace(list, 'a:443', 'dev-eks')).toBe('payments');
    expect(lastKubeNamespace(list, 'a:443', 'prod-eks')).toBe('other');
    expect(lastKubeNamespace(list, 'b:443', 'dev-eks')).toBeNull();
  });
});
