import { describe, expect, it } from 'vitest';
import { KUBE_OPERATIONS, KUBE_RESOURCE_TYPES, KUBE_WRITE_VERBS, buildKubectlArgs } from './kube';
import {
  IMAGE_REFERENCE,
  KUBE_ACTIONS,
  KUBE_DELETABLE,
  KUBE_FORWARDABLE,
  KUBE_REPLICAS_MAX,
  KUBE_ROLLABLE,
  KUBE_RULE_ACTIONS,
  KUBE_RULE_ACTION_DESCRIPTIONS,
  KUBE_SCALABLE,
  buildKubeActionArgs,
  buildPortForwardArgs,
  defaultJobName,
  isDestructiveKubeAction,
  kubeActionErrors,
  kubeActionTarget,
  kubeRuleAction,
  parseKubeAction,
  resolveKubeAction,
  type KubeAction,
} from './kube-actions';

const build = (action: string, params: Record<string, unknown> = {}) => buildKubeActionArgs(action, params);
const rejects = (action: string, params: Record<string, unknown>) => expect(() => build(action, params)).toThrow(/Invalid Kubernetes action/);

const ns = { namespace: 'payments' };

/** Every action with a sample, and the exact argv its template must give: the whole catalogue, one line each. */
const EXPECTED: { action: string; params: Record<string, unknown>; argv: string[] }[] = [
  { action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 3 }, argv: ['scale', 'deployments', 'api', '--namespace', 'payments', '--replicas', '3'] },
  { action: 'rollout-restart', params: { kind: 'statefulsets', name: 'db', ...ns }, argv: ['rollout', 'restart', 'statefulsets', 'db', '--namespace', 'payments'] },
  { action: 'rollout-undo', params: { kind: 'deployments', name: 'api', ...ns }, argv: ['rollout', 'undo', 'deployments', 'api', '--namespace', 'payments'] },
  { action: 'rollout-pause', params: { name: 'api', ...ns }, argv: ['rollout', 'pause', 'deployments', 'api', '--namespace', 'payments'] },
  { action: 'rollout-resume', params: { name: 'api', ...ns }, argv: ['rollout', 'resume', 'deployments', 'api', '--namespace', 'payments'] },
  { action: 'delete', params: { kind: 'pods', name: 'api-7d9f-abc12', ...ns }, argv: ['delete', 'pods', 'api-7d9f-abc12', '--namespace', 'payments'] },
  { action: 'cordon', params: { node: 'ip-10-0-0-1.ec2.internal' }, argv: ['cordon', 'ip-10-0-0-1.ec2.internal'] },
  { action: 'uncordon', params: { node: 'ip-10-0-0-1' }, argv: ['uncordon', 'ip-10-0-0-1'] },
  { action: 'set-image', params: { kind: 'daemonsets', name: 'agent', ...ns, container: 'agent', image: 'registry.example.com:5000/ops/agent:1.4.2' }, argv: ['set', 'image', 'daemonsets', 'agent', 'agent=registry.example.com:5000/ops/agent:1.4.2', '--namespace', 'payments'] },
  { action: 'cronjob-trigger', params: { name: 'nightly', ...ns, jobName: 'nightly-by-hand' }, argv: ['create', 'job', 'nightly-by-hand', '--from=cronjob/nightly', '--namespace', 'payments'] },
];

const sample = (i: number) => ({ action: EXPECTED[i].action, params: EXPECTED[i].params });

/** The kubectl verb each action may produce, and nothing else. */
const VERB: Record<string, string> = {
  scale: 'scale',
  'rollout-restart': 'rollout restart',
  'rollout-undo': 'rollout undo',
  'rollout-pause': 'rollout pause',
  'rollout-resume': 'rollout resume',
  delete: 'delete',
  cordon: 'cordon',
  uncordon: 'uncordon',
  'set-image': 'set image',
  'cronjob-trigger': 'create job',
};

describe('buildKubeActionArgs: exact argv per action', () => {
  it('covers every action in the catalogue', () => {
    expect(new Set(EXPECTED.map((e) => e.action))).toEqual(new Set(KUBE_ACTIONS.map((a) => a.id)));
    expect(new Set(Object.keys(VERB))).toEqual(new Set(KUBE_ACTIONS.map((a) => a.id)));
  });

  for (const { action, params, argv } of EXPECTED) {
    it(`${action} is exactly kubectl ${VERB[action]}`, () => {
      const built = build(action, params);
      expect(built).toEqual(argv);
      const info = KUBE_ACTIONS.find((a) => a.id === action)!;
      expect(info.command.join(' ')).toBe(VERB[action]);
      expect(built.slice(0, info.command.length)).toEqual([...info.command]);
    });
  }

  it('optional values', () => {
    expect(build('rollout-undo', { kind: 'deployments', name: 'api', ...ns, toRevision: 4 })).toEqual(['rollout', 'undo', 'deployments', 'api', '--namespace', 'payments', '--to-revision', '4']);
    expect(build('delete', { kind: 'jobs', name: 'migrate', ...ns, gracePeriodSeconds: 0 })).toEqual(['delete', 'jobs', 'migrate', '--namespace', 'payments', '--grace-period', '0']);
    expect(build('scale', { kind: 'replicasets', name: 'api-7d9f', ...ns, replicas: 0 })).toEqual(['scale', 'replicasets', 'api-7d9f', '--namespace', 'payments', '--replicas', '0']);
  });
});

describe('buildKubeActionArgs: rejects anything outside the catalogue', () => {
  it('unknown actions, including the ones left out on purpose', () => {
    for (const action of ['exec', 'apply', 'edit', 'patch', 'drain', 'replace', 'label', 'annotate', 'taint', 'run', 'cp', 'attach', 'debug', 'port-forward', 'delete-all', 'list']) rejects(action, { name: 'x', ...ns });
  });

  it('unknown fields: no selectors, no --all, no force, no free-form flags', () => {
    rejects('delete', { kind: 'pods', name: 'x', ...ns, selector: 'app=api' });
    rejects('delete', { kind: 'pods', name: 'x', ...ns, all: true });
    rejects('delete', { kind: 'pods', name: 'x', ...ns, force: true });
    rejects('scale', { kind: 'deployments', name: 'x', ...ns, replicas: 1, flags: ['--all'] });
    rejects('cordon', { node: 'n', selector: 'pool=a' });
    rejects('set-image', { kind: 'deployments', name: 'x', ...ns, container: 'c', image: 'nginx', all: true });
  });

  it('one named object: the name and the namespace are required', () => {
    rejects('delete', { kind: 'pods', ...ns });
    rejects('delete', { kind: 'pods', name: 'x' });
    rejects('scale', { kind: 'deployments', name: 'x', replicas: 1 });
    rejects('cordon', {});
  });

  it('enums leave out secrets and everything outside the action', () => {
    for (const list of [KUBE_SCALABLE, KUBE_ROLLABLE, KUBE_DELETABLE, KUBE_FORWARDABLE]) {
      expect(list as readonly string[]).not.toContain('secrets');
      expect(list as readonly string[]).not.toContain('serviceaccounts');
    }
    expect([...KUBE_DELETABLE]).toEqual(['pods', 'jobs']);
    rejects('delete', { kind: 'secrets', name: 'x', ...ns });
    rejects('delete', { kind: 'namespaces', name: 'payments' });
    rejects('delete', { kind: 'deployments', name: 'api', ...ns });
    rejects('scale', { kind: 'daemonsets', name: 'x', ...ns, replicas: 1 });
    rejects('rollout-restart', { kind: 'replicasets', name: 'x', ...ns });
    rejects('set-image', { kind: 'pods', name: 'x', ...ns, container: 'c', image: 'nginx' });
  });

  it('leading dashes in every string field', () => {
    for (const { action, params } of EXPECTED) {
      for (const [key, value] of Object.entries(params)) {
        if (typeof value !== 'string' || key === 'kind') continue;
        rejects(action, { ...params, [key]: `-${value}` });
        rejects(action, { ...params, [key]: `--${key}=x` });
      }
    }
  });

  it('spaces, shell characters, upper case and control characters', () => {
    for (const bad of ['api x', 'api;rm', 'api$(x)', 'API', 'api\n', 'a/b', '']) {
      rejects('scale', { kind: 'deployments', name: bad, ...ns, replicas: 1 });
      rejects('rollout-restart', { kind: 'deployments', name: 'api', namespace: bad });
    }
  });

  it('replica, revision and grace bounds', () => {
    rejects('scale', { kind: 'deployments', name: 'x', ...ns, replicas: -1 });
    rejects('scale', { kind: 'deployments', name: 'x', ...ns, replicas: KUBE_REPLICAS_MAX + 1 });
    rejects('scale', { kind: 'deployments', name: 'x', ...ns, replicas: 1.5 });
    rejects('scale', { kind: 'deployments', name: 'x', ...ns, replicas: '3' });
    expect(build('scale', { kind: 'deployments', name: 'x', ...ns, replicas: KUBE_REPLICAS_MAX }).at(-1)).toBe(String(KUBE_REPLICAS_MAX));
    rejects('rollout-undo', { kind: 'deployments', name: 'x', ...ns, toRevision: 0 });
    rejects('delete', { kind: 'pods', name: 'x', ...ns, gracePeriodSeconds: -1 });
    rejects('delete', { kind: 'pods', name: 'x', ...ns, gracePeriodSeconds: 3601 });
  });

  it('image references', () => {
    const good = [
      'nginx',
      'nginx:1.27',
      'library/nginx:latest',
      'ghcr.io/acme/api:v1.2.3',
      'registry.example.com:5000/team/app_name:2026-09-27',
      'localhost:5000/app',
      `nginx@sha256:${'a'.repeat(64)}`,
      `ghcr.io/acme/api:v1@sha256:${'0f'.repeat(32)}`,
    ];
    const bad = ['-nginx', 'nginx:', 'nginx:-1', 'Nginx/App', 'nginx latest', 'nginx;rm -rf', 'nginx:$(id)', 'nginx@sha256:xyz', 'nginx=evil', '', 'a//b', '/nginx', 'nginx:1.0 --all'];
    for (const image of good) expect(IMAGE_REFERENCE.test(image), image).toBe(true);
    for (const image of bad) expect(IMAGE_REFERENCE.test(image), image).toBe(false);
    for (const image of bad) rejects('set-image', { kind: 'deployments', name: 'api', ...ns, container: 'api', image });
    rejects('set-image', { kind: 'deployments', name: 'api', ...ns, container: 'api', image: `a${'b'.repeat(512)}` });
  });

  it('only template flags, and never another context, kubeconfig, server or identity', () => {
    const templateFlags = new Set(['--namespace', '--replicas', '--to-revision', '--grace-period']);
    for (const { action, params } of EXPECTED) {
      const argv = build(action, params);
      for (const arg of argv) if (arg.startsWith('-') && !arg.startsWith('--from=cronjob/')) expect(templateFlags.has(arg), arg).toBe(true);
      expect(argv.join(' ')).not.toMatch(/--(context|kubeconfig|server|as|as-group|token|user|cluster|all|selector|force|cascade|overwrite|filename|raw)\b|(^| )-[a-zA-Z]\b/);
    }
  });
});

describe('the two catalogues stay apart', () => {
  it('no action id is a query operation, so neither builder accepts the other', () => {
    const operations = new Set<string>(KUBE_OPERATIONS.map((o) => o.id));
    for (const a of KUBE_ACTIONS) {
      expect(operations.has(a.id)).toBe(false);
      expect(() => buildKubectlArgs(a.id, {})).toThrow(/Invalid Kubernetes query/);
    }
    for (const o of KUBE_OPERATIONS) expect(() => buildKubeActionArgs(o.id, {})).toThrow(/Invalid Kubernetes action/);
  });

  it('every action verb is one the read catalogue is proven never to produce', () => {
    const writes = new Set<string>(KUBE_WRITE_VERBS);
    for (const a of KUBE_ACTIONS) expect(writes.has(a.command[0]) || writes.has(a.command[1] ?? ''), a.id).toBe(true);
  });

  it('the read catalogue still has no secrets', () => {
    expect(KUBE_RESOURCE_TYPES as readonly string[]).not.toContain('secrets');
  });
});

describe('job names, targets and what is destructive', () => {
  const now = new Date('2026-10-22T09:30:00Z');

  it('cronjob-trigger gets its job name once, before the preview', () => {
    expect(() => build('cronjob-trigger', { name: 'nightly', ...ns })).toThrow(/resolve the action first/);
    const resolved = resolveKubeAction({ action: 'cronjob-trigger', params: { name: 'nightly', ...ns } }, now);
    expect(resolved.params).toEqual({ name: 'nightly', ...ns, jobName: defaultJobName('nightly', now) });
    expect(build(resolved.action, resolved.params)).toEqual(['create', 'job', defaultJobName('nightly', now), '--from=cronjob/nightly', '--namespace', 'payments']);
    // A given job name is kept, and other actions come back unchanged.
    expect(resolveKubeAction({ action: 'cronjob-trigger', params: { name: 'nightly', ...ns, jobName: 'mine' } }, now).params).toMatchObject({ jobName: 'mine' });
    const scale = { action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 1 } };
    expect(resolveKubeAction(scale, now)).toEqual(scale);
  });

  it('default job names are valid labels, even for long or dotted cronjob names', () => {
    for (const name of ['nightly', 'a'.repeat(253), 'report.daily.eu', `${'b'.repeat(50)}.c`]) {
      const job = defaultJobName(name, now);
      expect(job.length).toBeLessThanOrEqual(63);
      expect(job).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
      expect(job).toMatch(/-manual-[a-z0-9]+$/);
    }
  });

  it('names the object each action changes', () => {
    expect(kubeActionTarget(parseKubeAction({ action: 'cordon', params: { node: 'n1' } }))).toEqual({ kind: 'nodes', name: 'n1', namespace: null });
    expect(kubeActionTarget(parseKubeAction({ action: 'rollout-pause', params: { name: 'api', ...ns } }))).toEqual({ kind: 'deployments', name: 'api', namespace: 'payments' });
    expect(kubeActionTarget(parseKubeAction({ action: 'cronjob-trigger', params: { name: 'nightly', ...ns } }))).toEqual({ kind: 'cronjobs', name: 'nightly', namespace: 'payments' });
    expect(kubeActionTarget(parseKubeAction(sample(0)))).toEqual({ kind: 'deployments', name: 'api', namespace: 'payments' });
  });

  it('delete, scale to 0, rollout undo and cordon are destructive', () => {
    const destructive = (a: unknown) => isDestructiveKubeAction(parseKubeAction(a) as KubeAction);
    const byId = Object.fromEntries(EXPECTED.map((e, i) => [e.action, destructive(sample(i))]));
    expect(byId).toEqual({
      scale: false,
      'rollout-restart': false,
      'rollout-undo': true,
      'rollout-pause': false,
      'rollout-resume': false,
      delete: true,
      cordon: true,
      uncordon: false,
      'set-image': false,
      'cronjob-trigger': false,
    });
    expect(destructive({ action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 0 } })).toBe(true);
  });

  it('field errors are keyed by parameter', () => {
    expect(kubeActionErrors({ action: 'scale', params: { kind: 'deployments', name: '-x', namespace: 'payments', replicas: 2000 } })).toMatchObject({ name: expect.stringContaining('-'), replicas: expect.any(String) });
    expect(kubeActionErrors(sample(0))).toEqual({});
  });
});

describe('port forwards', () => {
  it('always on the loopback address, one named target', () => {
    expect(buildPortForwardArgs({ kind: 'services', name: 'api', ...ns, remotePort: 80, localPort: 18080 })).toEqual(['port-forward', 'services/api', '18080:80', '--address', '127.0.0.1', '--namespace', 'payments']);
    expect(buildPortForwardArgs({ kind: 'pods', name: 'api-7d9f-abc12', ...ns, remotePort: 5432, localPort: 15432 })[1]).toBe('pods/api-7d9f-abc12');
  });

  it('rejects other targets, ports out of range and extra fields', () => {
    const bad = (spec: Record<string, unknown>) => expect(() => buildPortForwardArgs({ kind: 'pods', name: 'api', ...ns, remotePort: 80, localPort: 18080, ...spec } as never)).toThrow(/Invalid port forward/);
    bad({ kind: 'secrets' });
    bad({ kind: 'nodes' });
    bad({ name: '-api' });
    bad({ remotePort: 0 });
    bad({ remotePort: 70000 });
    bad({ localPort: 80 });
    bad({ localPort: undefined });
    bad({ address: '0.0.0.0' });
  });
});

describe('kube actions for agent rules', () => {
  it('names every catalogue action, and a scale to 0 replicas apart', () => {
    const ns = { namespace: 'payments' };
    expect(kubeRuleAction(parseKubeAction({ action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 3 } }))).toBe('scale');
    expect(kubeRuleAction(parseKubeAction({ action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 0 } }))).toBe('scale-to-zero');
    expect(kubeRuleAction(parseKubeAction({ action: 'delete', params: { kind: 'pods', name: 'api-1', ...ns } }))).toBe('delete');
    expect(kubeRuleAction(parseKubeAction({ action: 'cordon', params: { node: 'n1' } }))).toBe('cordon');
    // Every catalogue action is a rule action, with a description.
    for (const info of KUBE_ACTIONS) expect(KUBE_RULE_ACTIONS).toContain(info.id);
    expect(KUBE_RULE_ACTIONS).toHaveLength(KUBE_ACTIONS.length + 1);
    for (const id of KUBE_RULE_ACTIONS) expect(KUBE_RULE_ACTION_DESCRIPTIONS[id]).toBeTruthy();
  });
});
