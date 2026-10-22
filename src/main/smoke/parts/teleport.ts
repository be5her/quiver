import { promises as fs } from 'node:fs';
import { connect } from 'node:net';
import path from 'node:path';
import type {
  DbConnectionSummary,
  DbConnectionTest,
  DbQueryResult,
  KubeActionPreview,
  KubeActionResult,
  KubeHistoryEntry,
  KubePortForward,
  KubePreview,
  KubeRunResult,
  KubeStreamRead,
  PendingApproval,
  TeleportDatabase,
  TeleportKubeCluster,
  TeleportLoginResult,
  TeleportPin,
  TeleportStatus,
  TeleportTunnel,
} from '@quiver/core';
import { definePart, until, processAlive } from '../part';

/** The operation or action of a history entry. */
const opOf = (e: KubeHistoryEntry) => (e.kind === 'action' ? e.action.action : e.query.operation);

/** The first line a TCP server sends, or null when nothing answers. */
function readBanner(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let data = '';
    const done = (value: string | null) => {
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(2000, () => done(null));
    sock.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) done(data.trim());
    });
    sock.on('error', () => done(null));
    sock.on('end', () => done(data.trim() || null));
  });
}

const isKubeStillProtected = (list: { proxy: string; name: string }[]) => list.some((k) => k.name === 'prod-eks');

export default definePart({
  name: 'teleport',
  summary: 'Teleport: the fake tsh, clusters, pins, tunnels, kube queries, actions, protected clusters and port forwards, agents over MCP, the sidebar and query view',
  async run(t) {
    const { host, check, run, ws, rpc, toolNames: names } = t;
    const { fakeRedis, fakeTsh } = t.fixtures;
    /** A PostgreSQL connection through Teleport saved without its Database field: opening it must explain itself. */
    const db_connection_save_postgres_without_database = async (workspaceId: string) => {
      const saved = await host.invoke('db.connection.save', { connection: { kind: 'postgres', name: 'pg no name', access: { type: 'teleport', proxy: '', database: 'analytics-pg', dbUser: 'readonly' } } }, { caller: 'ui', workspaceId });
      if (!saved.ok) return saved;
      const test = await host.invoke('db.connection.test', { id: (saved.result as { id: string }).id }, { caller: 'ui', workspaceId });
      await host.invoke('db.connection.delete', { id: (saved.result as { id: string }).id }, { caller: 'ui', workspaceId });
      return test;
    };

    // ---------- teleport: fake tsh driving status, login, db/kube listing, pins and tunnels across two clusters ----------
    interface ConnectOut {
      tunnel: TeleportTunnel;
      connection: DbConnectionSummary | null;
      message: string | null;
    }
    const { first, second } = fakeTsh.proxies;
    const clusterOf = (s: TeleportStatus, proxy: string) => s.clusters.find((c) => c.proxy === proxy);
    await run('config.update', { patch: { teleport: { proxies: [first], pins: [], tshPath: fakeTsh.command, loginOnLaunch: false } } }, null);
    const t0 = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: tsh from settings', t0.tshSource === 'settings' && t0.tshVersion === '16.0.0-fake', { tsh: t0.tsh, version: t0.tshVersion, error: t0.error });
    check('teleport: configured cluster shows as logged out', t0.state === 'logged-out' && t0.clusters.length === 1 && clusterOf(t0, first)?.state === 'logged-out' && clusterOf(t0, first)?.configured === true, t0.clusters);
    const dbsWhileOut = await host.invoke('teleport.db.list', { proxy: first }, { caller: 'ui', workspaceId: null });
    check('teleport: db list needs a session', !dbsWhileOut.ok && dbsWhileOut.error.code === 'TELEPORT_LOGIN_REQUIRED' && (dbsWhileOut.error.details as { proxy?: string })?.proxy === first, dbsWhileOut.ok ? 'ok?' : dbsWhileOut.error);
    const loginResult = await run<TeleportLoginResult>('teleport.login', {}, null);
    const c1 = clusterOf(loginResult.status, first);
    check('teleport: login completes', loginResult.ok && loginResult.proxy === first && c1?.state === 'logged-in' && c1.user === 'smoke-user' && c1.cluster === 'smoke.teleport.local' && c1.current, loginResult.output);
    check('teleport: login output shows the browser link', loginResult.output.some((l) => l.includes('http://127.0.0.1:61234')));
    check('teleport: certificate expiry parsed', typeof c1?.validUntil === 'string' && new Date(c1.validUntil).getTime() > Date.now(), c1?.validUntil);
    const added = await run<TeleportStatus>('teleport.cluster.add', { proxy: second }, null);
    check('teleport: cluster add lists it as logged out', added.clusters.length === 2 && clusterOf(added, second)?.state === 'logged-out' && clusterOf(added, second)?.configured === true, added.clusters.map((c) => [c.proxy, c.state]));
    const ambiguousLogin = await host.invoke('teleport.login', {}, { caller: 'ui', workspaceId: null });
    check('teleport: login needs a proxy with several clusters', !ambiguousLogin.ok && ambiguousLogin.error.code === 'INVALID_INPUT' && ambiguousLogin.error.message.includes(second), ambiguousLogin.ok ? 'ok?' : ambiguousLogin.error.message);
    const login2 = await run<TeleportLoginResult>('teleport.login', { proxy: second }, null);
    check(
      'teleport: second cluster logs in independently',
      login2.ok && clusterOf(login2.status, second)?.state === 'logged-in' && clusterOf(login2.status, first)?.state === 'logged-in' && clusterOf(login2.status, second)?.current === true && clusterOf(login2.status, first)?.current === false,
      login2.status.clusters.map((c) => [c.proxy, c.state, c.current]),
    );
    const dbs = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check(
      'teleport: db ls across clusters',
      dbs.length === 6 && dbs.filter((d) => d.proxy === first).length === 4 && dbs.find((d) => d.name === 'second-redis')?.proxy === second && dbs.find((d) => d.name === 'orders-mysql')?.allowedUsers.join(',') === 'app,readonly',
      dbs.map((d) => [d.proxy, d.name]),
    );
    const dbsSecond = await run<TeleportDatabase[]>('teleport.db.list', { proxy: second }, null);
    check('teleport: db ls for one cluster', dbsSecond.length === 2 && dbsSecond.every((d) => d.proxy === second && d.clusterName === 'second.teleport.local'), dbsSecond.map((d) => d.name));
    const kubes = await run<TeleportKubeCluster[]>('teleport.kube.list', {}, null);
    check('teleport: kube ls across clusters', kubes.length === 3 && kubes.every((k) => !k.selected) && kubes.find((k) => k.name === 'eu-eks')?.proxy === second, kubes);
    const kubeLogin = await run<{ proxy: string; cluster: string; output: string }>('teleport.kube.login', { cluster: 'dev-eks' }, null);
    const kubesAfter = await run<TeleportKubeCluster[]>('teleport.kube.list', { refresh: true }, null);
    const statusKube = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check(
      'teleport: kube login selects the cluster on the right proxy',
      kubeLogin.proxy === first && kubeLogin.output.includes('dev-eks') && kubesAfter.find((k) => k.name === 'dev-eks')?.selected === true && clusterOf(statusKube, first)?.kubeCluster === 'dev-eks' && !clusterOf(statusKube, second)?.kubeCluster,
      kubesAfter,
    );

    // ---------- teleport: read-only Kubernetes queries through tsh kubectl, a private kubeconfig and the query history ----------
    {
      const homeBefore = await fs.readFile(fakeTsh.homeKubeconfig, 'utf8');
      const kq = (query: unknown, extra: Record<string, unknown> = {}) => run<KubeRunResult>('teleport.kube.query', { proxy: first, cluster: 'prod-eks', query, ...extra }, null);
      const podsQuery = { operation: 'list', params: { resource: 'pods', namespace: 'payments' } };
      const previewFirst = await run<KubePreview>('teleport.kube.preview', { proxy: first, cluster: 'prod-eks', query: podsQuery }, null);
      check(
        'kube: preview before the first run shows the one-time setup',
        !previewFirst.contextConfirmed && /kube login prod-eks --proxy=smoke\.teleport\.local:443$/.test(previewFirst.setup ?? '') && (previewFirst.setup ?? '').includes('KUBECONFIG') && previewFirst.command.includes(' kubectl get pods --namespace payments --kubeconfig='),
        previewFirst,
      );
      const pods = await kq(podsQuery);
      check(
        'kube: list pods in a namespace',
        pods.exitCode === 0 && pods.stdout.includes('api-7d9f-abc12') && pods.stdout.includes('worker-5c8b-xyz34') && !pods.stdout.includes('hello-') && pods.command.includes(' kubectl get pods --namespace payments --kubeconfig=') && !pods.streaming,
        { command: pods.command, exit: pods.exitCode, stderr: pods.stderr, stdout: pods.stdout.slice(0, 200) },
      );
      const podsCall = (await fakeTsh.kubectlCalls()).at(-1);
      const privateConfig = podsCall?.argv.at(-2)?.replace(/^--kubeconfig=/, '') ?? '';
      check(
        'kube: argv is the template, then an explicit private kubeconfig and context (after the subcommand, where tsh accepts them)',
        JSON.stringify(podsCall?.argv.slice(0, -2)) === JSON.stringify(['get', 'pods', '--namespace', 'payments']) &&
          podsCall?.argv.at(-2)?.startsWith('--kubeconfig=') === true &&
          podsCall?.argv.at(-1) === '--context=smoke.teleport.local-prod-eks' &&
          path.resolve(privateConfig).startsWith(path.resolve(host.api.dataDir ?? '/nowhere')),
        podsCall,
      );
      check(
        'kube: the result shows exactly what was spawned, and the setup that ran',
        JSON.stringify(pods.argv.slice(-7)) === JSON.stringify(['kubectl', ...(podsCall?.argv ?? [])]) && pods.setup === previewFirst.setup,
        { argv: pods.argv, setup: pods.setup },
      );
      const previewAfter = await run<KubePreview>('teleport.kube.preview', { proxy: first, cluster: 'prod-eks', query: podsQuery }, null);
      check('kube: preview is the exact command that runs', previewAfter.contextConfirmed && previewAfter.setup === null && previewAfter.command === pods.command, previewAfter);
      const statusAfterQuery = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
      const homeAfter = await fs.readFile(fakeTsh.homeKubeconfig, 'utf8');
      check(
        'kube: the terminal kubeconfig current context is unchanged after a query',
        homeAfter === homeBefore && /current-context: smoke\.teleport\.local-dev-eks/.test(homeAfter) && clusterOf(statusAfterQuery, first)?.kubeCluster === 'dev-eks',
        { homeAfter, kube: clusterOf(statusAfterQuery, first)?.kubeCluster },
      );
      const logs = await kq({ operation: 'logs', params: { pod: 'api-7d9f-abc12', namespace: 'payments', container: 'istio-proxy', tail: 5, timestamps: true } });
      const logLines = logs.stdout.split('\n');
      check(
        'kube: logs with tail, container and timestamps',
        logs.exitCode === 0 && logLines.length === 5 && logLines.every((l) => l.includes('[istio-proxy]') && /^\d{4}-\d\d-\d\dT/.test(l)) && logLines[4].endsWith('line 300') && logs.command.includes(' kubectl logs api-7d9f-abc12 --namespace payments --container istio-proxy --tail 5 --timestamps --kubeconfig=') && logs.setup === null,
        { command: logs.command, lines: logLines },
      );
      const described = await kq({ operation: 'describe', params: { resource: 'pods', name: 'api-7d9f-abc12', namespace: 'payments' } });
      check('kube: describe', described.exitCode === 0 && described.stdout.includes('Name:         api-7d9f-abc12') && described.stdout.includes('istio-proxy'), described.stdout.slice(0, 200));
      const events = await kq({ operation: 'events', params: { namespace: 'payments' } });
      check('kube: events sorted by time', events.exitCode === 0 && events.stdout.includes('BackOff') && events.command.includes('--sort-by .lastTimestamp --kubeconfig='), events.command);
      const canDelete = await kq({ operation: 'can-i', params: { verb: 'delete', resource: 'pods', namespace: 'payments' } });
      const canGet = await kq({ operation: 'can-i', params: { verb: 'get', resource: 'pods', namespace: 'payments' } });
      check('kube: auth can-i answers without being an error', canDelete.exitCode === 1 && canDelete.stdout.trim() === 'no' && canGet.exitCode === 0 && canGet.stdout.trim() === 'yes');
      const missing = await kq({ operation: 'get', params: { resource: 'pods', name: 'nope', namespace: 'payments' } });
      check('kube: kubectl errors come back as stderr and exit code', missing.exitCode === 1 && missing.stderr.includes('NotFound'), missing.stderr);
      const callsBefore = (await fakeTsh.kubectlCalls()).length;
      const dashName = await host.invoke('teleport.kube.query', { proxy: first, cluster: 'prod-eks', query: { operation: 'get', params: { resource: 'pods', name: '-oyaml', namespace: 'payments' } } }, { caller: 'ui', workspaceId: null });
      check('kube: a name starting with "-" is rejected', !dashName.ok && dashName.error.code === 'INVALID_INPUT' && /name/.test(dashName.error.message), dashName.ok ? 'ok?' : dashName.error.message);
      const secrets = await host.invoke('teleport.kube.query', { proxy: first, cluster: 'prod-eks', query: { operation: 'list', params: { resource: 'secrets' } } }, { caller: 'ui', workspaceId: null });
      check('kube: secrets are not a resource type', !secrets.ok && secrets.error.code === 'INVALID_INPUT', secrets.ok ? 'ok?' : secrets.error.message);
      const badCluster = await host.invoke('teleport.kube.query', { proxy: first, cluster: '--insecure-skip-tls-verify', query: { operation: 'version', params: {} } }, { caller: 'ui', workspaceId: null });
      check('kube: cluster names are validated too', !badCluster.ok && badCluster.error.code === 'INVALID_INPUT');
      check('kube: rejected queries never reach kubectl', (await fakeTsh.kubectlCalls()).length === callsBefore);

      // Follow logs: streams until stopped, read incrementally.
      const follow = await kq({ operation: 'logs-follow', params: { pod: 'worker-5c8b-xyz34', namespace: 'payments', tail: 3 } }, { runId: 'smoke-follow' });
      await new Promise((r) => setTimeout(r, 700));
      const read1 = await run<KubeStreamRead>('teleport.kube.stream.read', { runId: 'smoke-follow' }, null);
      await new Promise((r) => setTimeout(r, 500));
      const read2 = await run<KubeStreamRead>('teleport.kube.stream.read', { runId: 'smoke-follow', since: read1.next }, null);
      check(
        'kube: follow logs streams new lines',
        follow.streaming && follow.runId === 'smoke-follow' && read1.running && read1.lines.length >= 4 && read1.lines[0].endsWith('line 298') && read2.lines.length >= 1 && read2.lines[0].endsWith(`line ${298 + read1.lines.length}`),
        { streaming: follow.streaming, read1: read1.lines.length, first: read1.lines[0], read2: read2.lines.slice(0, 2) },
      );
      // tsh kubectl runs kubectl in a second process that shares the output pipe; stopping has to end both.
      const followPid = (await fakeTsh.kubectlCalls()).findLast((c) => c.argv.includes('--follow'))?.pid;
      check('kube: follow logs runs in a second process, like tsh kubectl', processAlive(followPid), followPid);
      const stopped = await run<{ cancelled: boolean }>('teleport.kube.cancel', { runId: 'smoke-follow' }, null);
      // Well inside the 3 s fallback, so it is the tree kill that ends the run.
      const ended = await until(async () => !(await run<KubeStreamRead>('teleport.kube.stream.read', { runId: 'smoke-follow' }, null)).running, 2000);
      const read3 = await run<KubeStreamRead>('teleport.kube.stream.read', { runId: 'smoke-follow' }, null);
      await new Promise((r) => setTimeout(r, 500));
      const read4 = await run<KubeStreamRead>('teleport.kube.stream.read', { runId: 'smoke-follow', since: read3.next }, null);
      check('kube: stop ends the stream', stopped.cancelled && ended && !read3.running && read4.lines.length === 0, { cancelled: stopped.cancelled, ended, extra: read4.lines });
      check('kube: stop kills the process doing the work, not just tsh', await until(() => !processAlive(followPid), 1000), followPid);

      // History: recorded as operation and parameters, replayed through the same validation.
      await kq({ operation: 'namespaces', params: {} }, { record: false });
      const hist = await run<{ entries: KubeHistoryEntry[]; lastNamespace: string | null }>('teleport.kube.history.list', { proxy: first, cluster: 'prod-eks' }, null);
      const ops = hist.entries.map(opOf);
      check(
        'kube: history records each run with its params, not a command line',
        ops.length === 8 && ops[0] === 'logs-follow' && ops.at(-1) === 'list' && !ops.includes('namespaces') && hist.lastNamespace === 'payments' && !JSON.stringify(hist.entries).includes('kubectl') && hist.entries.every((e) => typeof e.durationMs === 'number' && e.at),
        ops,
      );
      const listEntry = hist.entries.at(-1)!;
      const rerun = await run<KubeRunResult>('teleport.kube.history.rerun', { id: listEntry.id }, null);
      check('kube: history entry replays', rerun.exitCode === 0 && rerun.stdout === pods.stdout && rerun.command === pods.command, rerun.command);
      const historyFile = path.join(host.api.dataDir ?? '', 'teleport-kube', 'history.json');
      const onDiskHistory = JSON.parse(await fs.readFile(historyFile, 'utf8')) as { entries: KubeHistoryEntry[] };
      onDiskHistory.entries.unshift(
        { ...listEntry, id: 'tampered-flag', query: { operation: 'list', params: { resource: 'pods', namespace: '--kubeconfig=/etc/passwd' } } } as unknown as KubeHistoryEntry,
        { ...listEntry, id: 'tampered-op', query: { operation: 'exec', params: { pod: 'x' } } } as unknown as KubeHistoryEntry,
        { ...listEntry, id: 'tampered-args', query: { operation: 'version', params: { args: ['delete', 'ns', 'payments'] } } } as unknown as KubeHistoryEntry,
      );
      await new Promise((r) => setTimeout(r, 30));
      await fs.writeFile(historyFile, JSON.stringify(onDiskHistory), 'utf8');
      const histTampered = await run<{ entries: KubeHistoryEntry[] }>('teleport.kube.history.list', { proxy: first, cluster: 'prod-eks' }, null);
      const tamperedRerun = await host.invoke('teleport.kube.history.rerun', { id: 'tampered-flag' }, { caller: 'ui', workspaceId: null });
      check(
        'kube: an edited history file cannot inject arguments',
        histTampered.entries.length === 9 && !histTampered.entries.some((e) => e.id.startsWith('tampered')) && !tamperedRerun.ok && tamperedRerun.error.code === 'NOT_FOUND',
        histTampered.entries.map((e) => e.id).slice(0, 4),
      );
      const pinnedEntry = await run<KubeHistoryEntry>('teleport.kube.history.pin', { id: listEntry.id }, null);
      await run('teleport.kube.history.delete', { id: histTampered.entries[0].id }, null);
      const cleared = await run<{ deleted: number }>('teleport.kube.history.clear', { proxy: first, cluster: 'prod-eks' }, null);
      const histAfterClear = await run<{ entries: KubeHistoryEntry[] }>('teleport.kube.history.list', { proxy: first, cluster: 'prod-eks' }, null);
      check(
        'kube: pin, delete and clear keep the favourite',
        pinnedEntry.pinned && cleared.deleted === 7 && histAfterClear.entries.length === 1 && histAfterClear.entries[0].id === listEntry.id && histAfterClear.entries[0].pinned,
        { deleted: cleared.deleted, left: histAfterClear.entries.map((e) => [opOf(e), e.pinned]) },
      );
      await kq({ operation: 'list', params: { resource: 'pods', namespace: 'payments' } });
      await kq({ operation: 'logs', params: { pod: 'api-7d9f-abc12', namespace: 'payments', tail: 20 } });
      check('kube: the terminal kubeconfig is still untouched', (await fs.readFile(fakeTsh.homeKubeconfig, 'utf8')) === homeBefore);
    }

    // ---------- teleport: Kubernetes actions from their own catalogue, protected clusters and port forwards ----------
    {
      const target = { proxy: first, cluster: 'prod-eks' };
      const preview = (action: unknown) => run<KubeActionPreview>('teleport.kube.action.preview', { ...target, action }, null);
      const lastArgv = async () => (await fakeTsh.kubectlCalls()).at(-1)?.argv.slice(0, -2) ?? [];
      const ns = { namespace: 'payments' };
      // The fake now answers the action verbs, so prove here that no read query ever sent one.
      const actionVerbs = ['scale', 'rollout restart', 'rollout undo', 'rollout pause', 'rollout resume', 'delete', 'cordon', 'uncordon', 'set image', 'create', 'port-forward'];
      const writesByQueries = (await fakeTsh.kubectlCalls()).filter((c) => actionVerbs.some((v) => c.argv.slice(0, v.split(' ').length).join(' ') === v));
      check('kube: no read query sent a write verb to kubectl', writesByQueries.length === 0, writesByQueries.map((c) => c.argv.slice(0, 3)));
      // Every action in the catalogue, previewed and then run with the action the preview gave back.
      const samples: { action: { action: string; params: Record<string, unknown> }; argv: (p: KubeActionPreview) => string[]; out: string }[] = [
        { action: { action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 3 } }, argv: () => ['scale', 'deployments', 'api', '--namespace', 'payments', '--replicas', '3'], out: 'deployment.apps/api scaled' },
        { action: { action: 'rollout-restart', params: { kind: 'deployments', name: 'api', ...ns } }, argv: () => ['rollout', 'restart', 'deployments', 'api', '--namespace', 'payments'], out: 'deployment.apps/api restarted' },
        { action: { action: 'rollout-undo', params: { kind: 'deployments', name: 'api', ...ns, toRevision: 1 } }, argv: () => ['rollout', 'undo', 'deployments', 'api', '--namespace', 'payments', '--to-revision', '1'], out: 'rolled back' },
        { action: { action: 'rollout-pause', params: { name: 'worker', ...ns } }, argv: () => ['rollout', 'pause', 'deployments', 'worker', '--namespace', 'payments'], out: 'deployment.apps/worker paused' },
        { action: { action: 'rollout-resume', params: { name: 'worker', ...ns } }, argv: () => ['rollout', 'resume', 'deployments', 'worker', '--namespace', 'payments'], out: 'deployment.apps/worker resumed' },
        { action: { action: 'delete', params: { kind: 'pods', name: 'worker-5c8b-xyz34', ...ns, gracePeriodSeconds: 5 } }, argv: () => ['delete', 'pods', 'worker-5c8b-xyz34', '--namespace', 'payments', '--grace-period', '5'], out: 'pod "worker-5c8b-xyz34" deleted' },
        { action: { action: 'cordon', params: { node: 'ip-10-0-0-1' } }, argv: () => ['cordon', 'ip-10-0-0-1'], out: 'node/ip-10-0-0-1 cordoned' },
        { action: { action: 'uncordon', params: { node: 'ip-10-0-0-1' } }, argv: () => ['uncordon', 'ip-10-0-0-1'], out: 'node/ip-10-0-0-1 uncordoned' },
        { action: { action: 'set-image', params: { kind: 'deployments', name: 'api', ...ns, container: 'api', image: 'ghcr.io/acme/api:1.4.2' } }, argv: () => ['set', 'image', 'deployments', 'api', 'api=ghcr.io/acme/api:1.4.2', '--namespace', 'payments'], out: 'image updated' },
        {
          action: { action: 'cronjob-trigger', params: { name: 'nightly-report', ...ns } },
          argv: (p) => ['create', 'job', String((p.action.params as { jobName?: string }).jobName), '--from=cronjob/nightly-report', '--namespace', 'payments'],
          out: 'created',
        },
      ];
      const argvWrong: unknown[] = [];
      const previewWrong: unknown[] = [];
      for (const sample of samples) {
        const p = await preview(sample.action);
        const result = await run<KubeActionResult>('teleport.kube.action', { ...target, action: p.action }, null);
        const received = await lastArgv();
        if (JSON.stringify(received) !== JSON.stringify(sample.argv(p)) || result.exitCode !== 0 || !result.stdout.includes(sample.out)) argvWrong.push({ action: sample.action.action, received, exit: result.exitCode, stdout: result.stdout, stderr: result.stderr });
        if (p.command !== result.command || JSON.stringify(p.argv) !== JSON.stringify(result.argv) || JSON.stringify(result.argv.slice(-received.length - 2, -2)) !== JSON.stringify(received)) previewWrong.push({ action: sample.action.action, preview: p.command, ran: result.command });
      }
      check('kube actions: each action reaches kubectl as exactly its template', argvWrong.length === 0, argvWrong);
      check('kube actions: the preview is exactly what ran, the CronJob job name included', previewWrong.length === 0, previewWrong);
      const destructivePreview = await preview({ action: 'scale', params: { kind: 'deployments', name: 'api', ...ns, replicas: 0 } });
      const plainPreview = await preview(samples[0].action);
      check(
        'kube actions: the preview names the object and says what is destructive',
        destructivePreview.destructive && !plainPreview.destructive && plainPreview.target.kind === 'deployments' && plainPreview.target.name === 'api' && !plainPreview.protected,
        { destructive: destructivePreview.destructive, plain: plainPreview.destructive, target: plainPreview.target },
      );
      const actionHist = await run<{ entries: KubeHistoryEntry[] }>('teleport.kube.history.list', target, null);
      const actionEntries = actionHist.entries.filter((e) => e.kind === 'action');
      check(
        'kube actions: every action goes into the history as an action, with its params and not a command line',
        actionEntries.length === samples.length && opOf(actionEntries[0]) === 'cronjob-trigger' && !JSON.stringify(actionEntries).includes('kubectl') && actionEntries.every((e) => e.exitCode === 0),
        actionEntries.map((e) => opOf(e)),
      );

      // Rejected before anything runs: unknown actions and fields, secrets, flag-shaped values, no namespace.
      const callsBeforeBad = (await fakeTsh.kubectlCalls()).length;
      const badActions = [
        { action: 'exec', params: { pod: 'api-7d9f-abc12', ...ns, command: ['sh'] } },
        { action: 'delete', params: { kind: 'pods', name: 'api-7d9f-abc12', ...ns, selector: 'app=api' } },
        { action: 'delete', params: { kind: 'secrets', name: 'db-password', ...ns } },
        { action: 'delete', params: { kind: 'pods', name: '--all', ...ns } },
        { action: 'scale', params: { kind: 'deployments', name: 'api', replicas: 2 } },
        { action: 'set-image', params: { kind: 'deployments', name: 'api', ...ns, container: 'api', image: 'nginx; rm -rf /' } },
      ];
      const badResults = [];
      for (const action of badActions) badResults.push(await host.invoke('teleport.kube.action', { ...target, action }, { caller: 'ui', workspaceId: null }));
      check(
        'kube actions: anything outside the catalogue is rejected and never reaches kubectl',
        badResults.every((r) => !r.ok && r.error.code === 'INVALID_INPUT') && (await fakeTsh.kubectlCalls()).length === callsBeforeBad,
        badResults.map((r) => (r.ok ? 'ok?' : r.error.message.slice(0, 80))),
      );

      // Agents: actions are gated, the preview is not; rerunning an action from history is gated, a query is not.
      const asAgent = (id: string, input: unknown) => host.invoke(id, input, { caller: 'mcp', workspaceId: null });
      const blocked = (r: Awaited<ReturnType<typeof asAgent>>, reason?: string) => !r.ok && r.error.code === 'MUTATION_BLOCKED' && (!reason || (r.error.details as { reason?: string } | undefined)?.reason === reason);
      const callsBeforeAgent = (await fakeTsh.kubectlCalls()).length;
      const agentAction = await asAgent('teleport.kube.action', { ...target, action: samples[0].action });
      const agentPreview = await asAgent('teleport.kube.action.preview', { ...target, action: samples[0].action });
      const agentRerunAction = await asAgent('teleport.kube.history.rerun', { id: actionEntries[0].id });
      const agentForward = await asAgent('teleport.kube.portForward.start', { ...target, kind: 'services', name: 'api', ...ns, remotePort: 80 });
      check(
        'mcp: kube actions, port forwards and rerunning an action are gated; the preview is allowed',
        blocked(agentAction) && blocked(agentRerunAction) && blocked(agentForward) && agentPreview.ok && (await fakeTsh.kubectlCalls()).length === callsBeforeAgent,
        { action: agentAction.ok || agentAction.error.code, rerun: agentRerunAction.ok || agentRerunAction.error.code, forward: agentForward.ok || agentForward.error.code },
      );
      const queryEntry = actionHist.entries.find((e) => e.kind === 'query');
      const agentRerunQuery = queryEntry ? await asAgent('teleport.kube.history.rerun', { id: queryEntry.id }) : null;
      check('mcp: rerunning a query from history stays allowed', Boolean(agentRerunQuery?.ok), agentRerunQuery && !agentRerunQuery.ok ? agentRerunQuery.error : queryEntry);
      check(
        'mcp lists the kube action tools',
        ['teleport_kube_action', 'teleport_kube_action_preview', 'teleport_kube_protect', 'teleport_kube_portForward_start', 'teleport_kube_portForward_list', 'teleport_kube_portForward_stop'].every((n) => names.includes(n)),
        names.filter((n) => n.startsWith('teleport_kube')),
      );

      // Protected cluster: Quiver needs the cluster name typed; agents are refused even with mutations allowed, unless Settings allow them.
      await run('teleport.kube.protect', { ...target, protected: true }, null);
      const kubesProtected = await run<TeleportKubeCluster[]>('teleport.kube.list', { proxy: first }, null);
      const protectedPreview = await preview(samples[0].action);
      const unconfirmed = await host.invoke('teleport.kube.action', { ...target, action: samples[0].action }, { caller: 'ui', workspaceId: null });
      const mistyped = await host.invoke('teleport.kube.action', { ...target, action: samples[0].action, confirmCluster: 'prod' }, { caller: 'ui', workspaceId: null });
      const confirmed = await host.invoke('teleport.kube.action', { ...target, action: samples[0].action, confirmCluster: 'prod-eks' }, { caller: 'ui', workspaceId: null });
      const needsConfirm = (r: typeof unconfirmed) => !r.ok && r.error.code === 'INVALID_INPUT' && (r.error.details as { needs?: string } | undefined)?.needs === 'confirmCluster';
      check(
        'kube protected: listed and previewed as protected; an action needs the cluster name typed',
        kubesProtected.find((k) => k.name === 'prod-eks')?.protected === true &&
          kubesProtected.find((k) => k.name === 'dev-eks')?.protected === false &&
          protectedPreview.protected &&
          needsConfirm(unconfirmed) &&
          needsConfirm(mistyped) &&
          confirmed.ok,
        { unconfirmed: unconfirmed.ok || unconfirmed.error, confirmed: confirmed.ok || confirmed.error },
      );
      const mcpBefore = host.config.get().mcp;
      await run('config.update', { patch: { mcp: { ...mcpBefore, permissions: { ...mcpBefore.permissions, mode: 'allow' } } } }, null);
      const callsBeforeProtected = (await fakeTsh.kubectlCalls()).length;
      const agentOnProtected = await asAgent('teleport.kube.action', { ...target, action: samples[0].action, confirmCluster: 'prod-eks' });
      const agentRerunOnProtected = await asAgent('teleport.kube.history.rerun', { id: actionEntries[0].id, confirmCluster: 'prod-eks' });
      const agentForwardOnProtected = await asAgent('teleport.kube.portForward.start', { ...target, kind: 'services', name: 'api', ...ns, remotePort: 80 });
      const agentUnprotect = await asAgent('teleport.kube.protect', { ...target, protected: false });
      // tsh kube login also takes other names for a cluster (an auto-discovered one's short name): writes need the exact listed name.
      const agentOtherName = await asAgent('teleport.kube.action', { proxy: first, cluster: 'PROD-EKS', action: samples[0].action });
      const agentOtherNameForward = await asAgent('teleport.kube.portForward.start', { proxy: first, cluster: 'prod', kind: 'services', name: 'api', ...ns, remotePort: 80 });
      const uiOtherName = await host.invoke('teleport.kube.action', { proxy: first, cluster: 'prod', action: samples[0].action }, { caller: 'ui', workspaceId: null });
      check(
        'kube protected: actions and port forwards need the exact listed cluster name, so another name cannot reach a protected cluster',
        [agentOtherName, agentOtherNameForward, uiOtherName].every((r) => !r.ok && r.error.code === 'NOT_FOUND'),
        [agentOtherName, agentOtherNameForward, uiOtherName].map((r) => (r.ok ? 'ok?' : r.error.code)),
      );
      const refusedOnProtected = (await fakeTsh.kubectlCalls()).length === callsBeforeProtected;
      const agentOnOther = await asAgent('teleport.kube.action', { proxy: first, cluster: 'dev-eks', action: samples[0].action });
      check(
        'kube protected: agents are refused actions, reruns and port forwards there even with mutations allowed, and cannot unprotect it',
        blocked(agentOnProtected, 'protected-cluster') &&
          blocked(agentRerunOnProtected, 'protected-cluster') &&
          blocked(agentForwardOnProtected, 'protected-cluster') &&
          blocked(agentUnprotect, 'protected-cluster') &&
          refusedOnProtected &&
          isKubeStillProtected(host.config.get().teleport.protectedKubes),
        { action: agentOnProtected.ok || agentOnProtected.error, unprotect: agentUnprotect.ok || agentUnprotect.error.code },
      );
      check('kube protected: agents with mutations allowed act on other clusters', agentOnOther.ok && (agentOnOther.result as KubeActionResult).exitCode === 0 && (agentOnOther.result as KubeActionResult).command.includes('--context=smoke.teleport.local-dev-eks'), agentOnOther.ok ? 'ok' : agentOnOther.error);
      // Agent permissions cover the kube actions: under mode ask an agent's action waits for the user, and runs once allowed.
      await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: { ...mcpBefore.permissions, mode: 'ask' } } } }, null);
      const approvals = () => run<PendingApproval[]>('mcp.approval.list', {}, null);
      const callsBeforeAsk = (await fakeTsh.kubectlCalls()).length;
      const askedAction = asAgent('teleport.kube.action', { proxy: first, cluster: 'dev-eks', action: samples[0].action });
      await until(async () => (await approvals()).some((p) => p.commandId === 'teleport.kube.action'), 5000);
      const kubeApproval = (await approvals()).find((p) => p.commandId === 'teleport.kube.action');
      const waitedForUser = (await fakeTsh.kubectlCalls()).length === callsBeforeAsk;
      if (kubeApproval) await run('mcp.approval.respond', { id: kubeApproval.id, choice: 'once' }, null);
      const askedResult = await askedAction;
      check(
        "kube actions: under permission mode ask an agent's action raises an approval, waits for it, and runs once allowed",
        kubeApproval?.mutating === true &&
          (kubeApproval.input as { cluster?: string } | undefined)?.cluster === 'dev-eks' &&
          waitedForUser &&
          askedResult.ok &&
          (askedResult.result as KubeActionResult).exitCode === 0,
        { approval: kubeApproval && { tool: kubeApproval.commandId, mutating: kubeApproval.mutating }, waitedForUser, result: askedResult.ok || askedResult.error },
      );
      const askedPreview = await asAgent('teleport.kube.action.preview', { proxy: first, cluster: 'dev-eks', action: samples[0].action });
      check('kube actions: the action preview stays open to agents under mode ask', askedPreview.ok && (await approvals()).length === 0, askedPreview.ok || askedPreview.error);
      // A protected cluster refuses agents whatever the user answers, so under mode ask nobody is asked first.
      const callsBeforeAskProtected = (await fakeTsh.kubectlCalls()).length;
      const askedProtected = await asAgent('teleport.kube.action', { ...target, action: samples[0].action });
      const askedProtectedRerun = await asAgent('teleport.kube.history.rerun', { id: actionEntries[0].id });
      const askedProtectedForward = await asAgent('teleport.kube.portForward.start', { ...target, kind: 'services', name: 'web', namespace: 'payments', remotePort: 80 });
      check(
        'kube protected: under mode ask an agent is refused on a protected cluster without an approval being raised',
        blocked(askedProtected, 'protected-cluster') &&
          blocked(askedProtectedRerun, 'protected-cluster') &&
          blocked(askedProtectedForward, 'protected-cluster') &&
          (await approvals()).length === 0 &&
          (await fakeTsh.kubectlCalls()).length === callsBeforeAskProtected,
        {
          action: askedProtected.ok || askedProtected.error,
          rerun: askedProtectedRerun.ok || askedProtectedRerun.error.code,
          forward: askedProtectedForward.ok || askedProtectedForward.error.code,
          pending: (await approvals()).map((p) => p.commandId),
        },
      );
      await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: { ...mcpBefore.permissions, mode: 'allow' } } } }, null);
      await run('config.update', { patch: { teleport: { ...host.config.get().teleport, agentActionsOnProtected: true } } }, null);
      const agentAllowed = await asAgent('teleport.kube.action', { ...target, action: samples[0].action });
      check('kube protected: the Settings switch lets agents act on protected clusters', agentAllowed.ok && (agentAllowed.result as KubeActionResult).exitCode === 0, agentAllowed.ok ? 'ok' : agentAllowed.error);
      await run('config.update', { patch: { teleport: { ...host.config.get().teleport, agentActionsOnProtected: false }, mcp: mcpBefore } }, null);
      await run('teleport.kube.protect', { ...target, protected: false }, null);
      const lastEntry = (await run<{ entries: KubeHistoryEntry[] }>('teleport.kube.history.list', target, null)).entries[0];
      check('kube actions: history records who ran an action', lastEntry?.kind === 'action' && lastEntry.caller === 'mcp', lastEntry && [lastEntry.kind, lastEntry.caller]);

      // Port forwards: a real listener through the fake, listed, reused, and gone as a process tree when stopped.
      const forward = await run<KubePortForward>('teleport.kube.portForward.start', { ...target, kind: 'services', name: 'api', ...ns, remotePort: 80 }, null);
      const forwardCall = (await fakeTsh.kubectlCalls()).findLast((c) => c.argv[0] === 'port-forward');
      const banner = await readBanner(forward.localPort);
      const again = await run<KubePortForward>('teleport.kube.portForward.start', { ...target, kind: 'services', name: 'api', ...ns, remotePort: 80 }, null);
      const listed = await run<KubePortForward[]>('teleport.kube.portForward.list', { proxy: first }, null);
      check(
        'kube port forward: starts on 127.0.0.1 with the exact argv, and a TCP connection reaches the target',
        forward.state === 'running' &&
          forward.url === `http://127.0.0.1:${forward.localPort}` &&
          JSON.stringify(forwardCall?.argv.slice(0, -2)) === JSON.stringify(['port-forward', 'services/api', `${forward.localPort}:80`, '--address', '127.0.0.1', '--namespace', 'payments']) &&
          forward.command.includes(' kubectl port-forward services/api ') &&
          banner === 'fake port-forward services/api:80 in payments',
        { forward, argv: forwardCall?.argv, banner },
      );
      check('kube port forward: listed, and the same target is reused', again.id === forward.id && listed.length === 1 && listed[0].id === forward.id && listed[0].state === 'running', listed);
      check('kube port forward: runs in a second process, like tsh kubectl', processAlive(forwardCall?.pid), forwardCall?.pid);
      const forwardStopped = await run<{ stopped: boolean }>('teleport.kube.portForward.stop', { id: forward.id }, null);
      const listedAfter = await run<KubePortForward[]>('teleport.kube.portForward.list', {}, null);
      check(
        'kube port forward: stop ends the process tree and frees the port',
        forwardStopped.stopped && listedAfter.length === 0 && (await until(() => !processAlive(forwardCall?.pid), 2000)) && (await readBanner(forward.localPort)) === null,
        { stopped: forwardStopped.stopped, left: listedAfter.length, alive: processAlive(forwardCall?.pid) },
      );
      const twin = { ...target, kind: 'pods', name: 'api-7d9f-abc12', ...ns, remotePort: 8080 };
      const [twinA, twinB] = await Promise.all([run<KubePortForward>('teleport.kube.portForward.start', twin, null), run<KubePortForward>('teleport.kube.portForward.start', twin, null)]);
      const twinsListed = await run<KubePortForward[]>('teleport.kube.portForward.list', {}, null);
      await run('teleport.kube.portForward.stop', { id: twinA.id }, null);
      check('kube port forward: two identical starts at once share one forward', twinA.id === twinB.id && twinsListed.length === 1, { a: twinA.id, b: twinB.id, listed: twinsListed.length });
      const badForward = await host.invoke('teleport.kube.portForward.start', { ...target, kind: 'pods', name: 'no-such-pod', ...ns, remotePort: 80 }, { caller: 'ui', workspaceId: null });
      const flagForward = await host.invoke('teleport.kube.portForward.start', { ...target, kind: 'pods', name: '--address=0.0.0.0', ...ns, remotePort: 80 }, { caller: 'ui', workspaceId: null });
      check(
        'kube port forward: a failing forward reports kubectl\'s error, a flag-shaped name is rejected',
        !badForward.ok && badForward.error.code === 'REQUEST_FAILED' && /not found/.test(badForward.error.message) && !flagForward.ok && flagForward.error.code === 'INVALID_INPUT' && (await run<KubePortForward[]>('teleport.kube.portForward.list', {}, null)).length === 0,
        { bad: badForward.ok || badForward.error.message, flag: flagForward.ok || flagForward.error.code },
      );
    }
    const pins1 = await run<TeleportPin[]>('teleport.pin', { proxy: first, kind: 'db', name: 'smoke-redis' }, null);
    const pins2 = await run<TeleportPin[]>('teleport.pin', { proxy: second, kind: 'kube', name: 'eu-eks', pinned: true }, null);
    check('teleport: pins from both clusters', pins1.length === 1 && pins2.length === 2 && pins2.some((p) => p.proxy === second && p.kind === 'kube' && p.name === 'eu-eks'), pins2);
    const pinnedDbs = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check('teleport: db list flags pinned', pinnedDbs.find((d) => d.name === 'smoke-redis')?.pinned === true && pinnedDbs.find((d) => d.name === 'second-redis')?.pinned === false);
    const pinsToggled = await run<TeleportPin[]>('teleport.pin', { proxy: 'SMOKE.teleport.local', kind: 'db', name: 'smoke-redis' }, null);
    check('teleport: pin toggles off with a loosely written proxy', pinsToggled.length === 1 && pinsToggled[0].kind === 'kube', pinsToggled);
    await run('teleport.pin', { proxy: first, kind: 'db', name: 'smoke-redis', pinned: true }, null);
    const statusPins = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: status carries pins and the config keeps them', statusPins.pins.length === 2 && host.config.get().teleport.pins.length === 2);
    const connected = await run<ConnectOut>('teleport.db.connect', { database: 'smoke-redis' }, ws.id);
    check(
      'teleport: db connect infers the cluster, starts a tunnel and creates a connection',
      connected.tunnel.port > 0 && connected.tunnel.proxy === first && connected.connection?.kind === 'redis' && connected.connection.access.type === 'teleport' && connected.connection.access.proxy === first && connected.connection.access.dbUser === 'default',
      { tunnel: connected.tunnel.port, connection: connected.connection?.access },
    );
    const teleportConn = connected.connection!;
    const viaTunnel = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING\nLLEN queue', record: false }, ws.id);
    check('teleport: query through the tunnel', viaTunnel[0].value === 'PONG' && viaTunnel[1].value === 3, viaTunnel.map((r) => r.value));
    const again = await run<ConnectOut>('teleport.db.connect', { database: 'smoke-redis' }, ws.id);
    check('teleport: connect reuses tunnel and connection', again.tunnel.id === connected.tunnel.id && again.connection?.id === teleportConn.id);
    const onSecond = await run<ConnectOut>('teleport.db.connect', { proxy: second, database: 'second-redis' }, ws.id);
    check(
      'teleport: connect on the second cluster',
      onSecond.tunnel.proxy === second && onSecond.connection?.access.type === 'teleport' && onSecond.connection.access.proxy === second && onSecond.connection.id !== teleportConn.id,
      onSecond.connection?.access,
    );
    const viaSecond = await run<DbQueryResult[]>('db.query.run', { connectionId: onSecond.connection!.id, query: 'PING', record: false }, ws.id);
    check('teleport: query through the second cluster tunnel', viaSecond[0].value === 'PONG');
    const pgNoName = await host.invoke('teleport.db.connect', { database: 'analytics-pg', dbUser: 'readonly' }, { caller: 'ui', workspaceId: ws.id });
    const pgOnly = await run<ConnectOut>('teleport.db.connect', { database: 'analytics-pg', dbUser: 'readonly', dbName: 'analytics' }, ws.id);
    check(
      'teleport: postgres asks for the database name, then tunnels with --db-name and gets a connection',
      !pgNoName.ok &&
        pgNoName.error.code === 'INVALID_INPUT' &&
        (pgNoName.error.details as { needs?: string })?.needs === 'dbName' &&
        pgOnly.tunnel.port > 0 &&
        pgOnly.tunnel.dbName === 'analytics' &&
        pgOnly.connection?.kind === 'postgres' &&
        pgOnly.connection.database === 'analytics' &&
        pgOnly.connection.user === 'readonly',
      { noName: pgNoName.ok ? 'ok?' : pgNoName.error.message, tunnel: pgOnly.tunnel, connection: pgOnly.connection },
    );
    const pgKindless = await db_connection_save_postgres_without_database(ws.id);
    check('teleport: a postgres connection without a database name says what to fill in', !pgKindless.ok && pgKindless.error.code === 'INVALID_INPUT' && /Database field/.test(pgKindless.error.message), pgKindless.ok ? 'ok?' : pgKindless.error.message);
    if (pgOnly.connection) await run('db.connection.delete', { id: pgOnly.connection.id }, ws.id);
    const ambiguous = await host.invoke('teleport.db.connect', { database: 'orders-mysql' }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: ambiguous db user is refused with the allowed list', !ambiguous.ok && ambiguous.error.code === 'INVALID_INPUT' && /app, readonly/.test(ambiguous.error.message), ambiguous.ok ? 'ok?' : ambiguous.error.message);
    const status1 = await run<TeleportStatus>('teleport.status', {}, null);
    const redisTunnel = status1.tunnels.find((t) => t.target === 'smoke-redis');
    check(
      'teleport: status lists tunnels per cluster with their users',
      status1.tunnels.length === 3 && Boolean(redisTunnel?.users.includes('pinned')) && Boolean(redisTunnel?.users.some((u) => u.endsWith(`/${teleportConn.id}`))) && status1.tunnels.some((t) => t.proxy === second),
      status1.tunnels.map((t) => [t.proxy, t.target, t.users]),
    );
    const dbsWithTunnel = await run<TeleportDatabase[]>('teleport.db.list', {}, null);
    check('teleport: db list shows the tunnel', dbsWithTunnel.find((d) => d.name === 'smoke-redis')?.tunnel?.port === connected.tunnel.port);
    const stopped = await run<{ stopped: number }>('teleport.db.disconnect', { database: 'smoke-redis' }, null);
    const statusStopped = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: disconnect stops one tunnel and leaves the others', stopped.stopped === 1 && !statusStopped.tunnels.some((t) => t.target === 'smoke-redis') && statusStopped.tunnels.some((t) => t.target === 'second-redis'), statusStopped.tunnels.map((t) => t.target));
    const auto = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, ws.id);
    const status2 = await run<TeleportStatus>('teleport.status', {}, null);
    const restarted = status2.tunnels.find((t) => t.target === 'smoke-redis');
    check('teleport: query restarts a stopped tunnel', auto[0].value === 'PONG' && Boolean(restarted) && restarted?.id !== connected.tunnel.id, restarted?.id);
    await run('teleport.db.disconnect', { tunnelId: pgOnly.tunnel.id }, null);
    const broken = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'redis', name: 'broken', access: { type: 'teleport', proxy: first, database: 'broken-db', dbUser: 'default' } } }, ws.id);
    const brokenTest = await host.invoke('db.connection.test', { id: broken.id }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: tunnel stderr surfaces as the connection error', !brokenTest.ok && brokenTest.error.code === 'REQUEST_FAILED' && /broken-db.*not found/.test(brokenTest.error.message), brokenTest.ok ? 'ok?' : brokenTest.error.message);
    const cmdConn = await run<DbConnectionSummary>(
      'db.connection.save',
      { connection: { kind: 'redis', name: 'via command', access: { type: 'command', command: `${fakeTsh.command} __forward {port} ${fakeRedis.port}` } }, password: 'hunter2' },
      ws.id,
    );
    const cmdTest = await run<DbConnectionTest>('db.connection.test', { id: cmdConn.id }, ws.id);
    check('teleport: command tunnel with {port} placeholder', cmdTest.serverVersion === 'Redis 7.2.0-fake', cmdTest.serverVersion);
    const status3 = await run<TeleportStatus>('teleport.status', {}, null);
    check('teleport: command tunnel listed', status3.tunnels.some((t) => t.kind === 'command' && t.target.includes('__forward')), status3.tunnels.map((t) => t.kind));
    const badCmd = await host.invoke('db.connection.test', { connection: { kind: 'redis', name: 'x', access: { type: 'command', command: 'definitely-not-a-program-xyz {port}' } } }, { caller: 'ui', workspaceId: ws.id });
    check('teleport: missing tunnel program is reported', !badCmd.ok && /definitely-not-a-program-xyz/.test(badCmd.error.message), badCmd.ok ? 'ok?' : badCmd.error.message);
    // Expired certificate on one cluster only: its tunnel is down, so the next query must ask for a login while the other cluster keeps working.
    await run('teleport.db.disconnect', { database: 'smoke-redis' }, null);
    await fakeTsh.expire(first);
    const expired = await run<TeleportStatus>('teleport.status', { refresh: true }, null);
    check('teleport: expired certificate detected per cluster', clusterOf(expired, first)?.state === 'expired' && clusterOf(expired, second)?.state === 'logged-in' && expired.state === 'logged-in', expired.clusters.map((c) => [c.proxy, c.state]));
    const expiredQuery = await host.invoke('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, { caller: 'ui', workspaceId: ws.id });
    check(
      'teleport: expired session yields TELEPORT_LOGIN_REQUIRED naming the cluster',
      !expiredQuery.ok && expiredQuery.error.code === 'TELEPORT_LOGIN_REQUIRED' && (expiredQuery.error.details as { proxy?: string })?.proxy === first,
      expiredQuery.ok ? 'ok?' : expiredQuery.error,
    );
    const stillSecond = await run<DbQueryResult[]>('db.query.run', { connectionId: onSecond.connection!.id, query: 'PING', record: false }, ws.id);
    check('teleport: the other cluster keeps working', stillSecond[0].value === 'PONG');
    const relogin = await run<TeleportLoginResult>('teleport.login', { proxy: first }, null);
    check('teleport: log in again restores the cluster', relogin.ok && clusterOf(relogin.status, first)?.state === 'logged-in', relogin.status.clusters.map((c) => [c.proxy, c.state]));
    const afterRelogin = await run<DbQueryResult[]>('db.query.run', { connectionId: teleportConn.id, query: 'PING', record: false }, ws.id);
    check('teleport: query works after re-login', afterRelogin[0].value === 'PONG');

    check(
      'mcp lists teleport tools',
      ['teleport_status', 'teleport_db_list', 'teleport_db_connect', 'teleport_kube_list', 'teleport_pin', 'teleport_cluster_add'].every((n) => names.includes(n)) && !names.includes('teleport_login_cancel'),
      { total: names.length, teleport: names.filter((n) => n.startsWith('teleport')) },
    );
    const mcpTeleport = await rpc('tools/call', { name: 'teleport_status', arguments: {} });
    const mcpTeleportText = mcpTeleport.result?.content?.[0]?.text ?? '';
    const mcpTeleportStatus = mcpTeleportText.startsWith('{') ? (JSON.parse(mcpTeleportText) as TeleportStatus) : null;
    check('mcp reads teleport status with every cluster', mcpTeleportStatus?.state === 'logged-in' && mcpTeleportStatus.clusters.length === 2, mcpTeleportText.slice(0, 200) || mcpTeleport.error);
    const mcpDbs = await rpc('tools/call', { name: 'teleport_db_list', arguments: {} });
    check('mcp lists teleport databases across clusters', (JSON.parse(mcpDbs.result?.content?.[0]?.text ?? '[]') as unknown[]).length === 6);
    for (const tool of ['teleport_login', 'teleport_logout', 'teleport_kube_login', 'teleport_db_disconnect', 'teleport_cluster_remove']) {
      const blockedTool = await rpc('tools/call', {
        name: tool,
        arguments: tool === 'teleport_kube_login' ? { cluster: 'prod-eks' } : tool === 'teleport_db_disconnect' ? { database: 'smoke-redis' } : tool === 'teleport_cluster_remove' ? { proxy: second } : {},
      });
      check(`mcp blocks ${tool} by default`, blockedTool.result?.isError === true && (blockedTool.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }
    // Kubernetes over MCP: the catalogue is the tool schema, queries and history listing are allowed, history edits are gated.
    {
      const listed = (await rpc('tools/list', {})) as unknown as { result?: { tools?: { name: string; inputSchema?: unknown }[] } };
      const kubeTool = listed.result?.tools?.find((t) => t.name === 'teleport_kube_query');
      const schemaText = JSON.stringify(kubeTool?.inputSchema ?? {});
      check(
        'mcp: kube query schema lists the operations and no secrets',
        ['logs-follow', 'rollout-status', 'can-i', 'persistentvolumeclaims'].every((s) => schemaText.includes(`"${s}"`)) && !schemaText.includes('"secrets"') && names.includes('teleport_kube_history_list'),
        schemaText.slice(0, 300),
      );
      const kubeCall = (args: unknown) => rpc('tools/call', { name: 'teleport_kube_query', arguments: args });
      const mcpNs = await kubeCall({ proxy: first, cluster: 'prod-eks', query: { operation: 'namespaces', params: {} } });
      const mcpNsOut = JSON.parse(mcpNs.result?.content?.[0]?.text ?? '{}') as Partial<KubeRunResult>;
      check('mcp: read-only kube query is allowed without mutations', mcpNs.result?.isError !== true && mcpNsOut.exitCode === 0 && (mcpNsOut.stdout ?? '').includes('payments'), mcpNs.result?.content?.[0]?.text?.slice(0, 200));
      const callsBeforeMcp = (await fakeTsh.kubectlCalls()).length;
      const mcpUnknown = await kubeCall({ proxy: first, cluster: 'prod-eks', query: { operation: 'exec', params: { pod: 'api-7d9f-abc12', command: ['sh'] } } });
      // Refused by the SDK's schema check or by the registry, depending on where it fails first; either way kubectl never runs.
      const unknownText = mcpUnknown.result?.content?.[0]?.text ?? '';
      check(
        'mcp: unknown kube operation is rejected',
        mcpUnknown.result?.isError === true && /INVALID_INPUT|Input validation error/.test(unknownText) && (await fakeTsh.kubectlCalls()).length === callsBeforeMcp,
        unknownText.slice(0, 200),
      );
      const mcpRaw = await kubeCall({ proxy: first, cluster: 'prod-eks', query: { operation: 'version', params: {} }, args: ['delete', 'ns', 'payments'], command: 'kubectl delete ns payments' });
      const mcpRawOut = JSON.parse(mcpRaw.result?.content?.[0]?.text ?? '{}') as Partial<KubeRunResult>;
      const rawCall = (await fakeTsh.kubectlCalls()).at(-1);
      check('mcp: extra raw arguments are ignored, never passed on', JSON.stringify(rawCall?.argv.slice(0, -2)) === '["version"]' && JSON.stringify(mcpRawOut.argv?.slice(-3, -2)) === '["version"]', rawCall);
      const mcpParamFlag = await kubeCall({ proxy: first, cluster: 'prod-eks', query: { operation: 'logs', params: { pod: 'api-7d9f-abc12', flags: '--all-containers' } } });
      check('mcp: unknown kube params are rejected', mcpParamFlag.result?.isError === true && (await fakeTsh.kubectlCalls()).length === callsBeforeMcp + 1);
      const mcpHist = await rpc('tools/call', { name: 'teleport_kube_history_list', arguments: { cluster: 'prod-eks' } });
      check('mcp: kube history list is allowed', mcpHist.result?.isError !== true && (mcpHist.result?.content?.[0]?.text ?? '').includes('"entries"'));
      for (const [tool, args] of [
        ['teleport_kube_history_delete', { id: 'x' }],
        ['teleport_kube_history_clear', {}],
      ] as const) {
        const blockedKube = await rpc('tools/call', { name: tool, arguments: args });
        check(`mcp blocks ${tool} by default`, blockedKube.result?.isError === true && (blockedKube.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
      }
    }
    const mcpConnect = await rpc('tools/call', { name: 'teleport_db_connect', arguments: { database: 'smoke-redis' } });
    check('mcp can open a teleport tunnel for reads', mcpConnect.result?.isError !== true && (JSON.parse(mcpConnect.result?.content?.[0]?.text ?? '{}') as ConnectOut).tunnel?.port > 0, mcpConnect.result?.content?.[0]?.text?.slice(0, 200));
    const mcpPin = await rpc('tools/call', { name: 'teleport_pin', arguments: { proxy: second, kind: 'db', name: 'second-mysql', pinned: true } });
    check('mcp can pin a resource', mcpPin.result?.isError !== true && (JSON.parse(mcpPin.result?.content?.[0]?.text ?? '[]') as TeleportPin[]).length === 3, mcpPin.result?.content?.[0]?.text?.slice(0, 200));

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        await js(`document.documentElement.classList.add('dark')`);
        // Teleport module: one section per cluster, pinned resources from both, tunnels, kube clusters.
        const clickedTeleport = await js(
          `(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Teleport'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: teleport module button', clickedTeleport === true);
        await wait(1500);
        const clusterRows = await js(`[...document.querySelectorAll('[data-testid=teleport-cluster]')].map((r) => [r.getAttribute('data-proxy'), r.getAttribute('data-state')])`);
        check('ui: both clusters listed as logged in', Array.isArray(clusterRows) && clusterRows.length === 2 && clusterRows.every((r: string[]) => r[1] === 'logged-in'), clusterRows);
        const clusterText = await js(`[...document.querySelectorAll('[data-testid=teleport-cluster]')].map((r) => r.textContent).join(' | ')`);
        check('ui: cluster headers show name, user and countdown', typeof clusterText === 'string' && clusterText.includes('smoke.teleport.local') && clusterText.includes('second.teleport.local') && clusterText.includes('smoke-user') && /\d+h \d+m/.test(clusterText), clusterText);
        const pinRows = await js(`[...document.querySelectorAll('[data-testid=teleport-pin]')].map((r) => r.textContent)`);
        check('ui: pinned resources from both clusters', Array.isArray(pinRows) && pinRows.length === 3 && pinRows.some((t: string) => t.includes('smoke-redis')) && pinRows.some((t: string) => t.includes('eu-eks')) && pinRows.some((t: string) => t.includes('second-mysql')), pinRows);
        const dbRows = await js(`document.querySelectorAll('[data-testid=teleport-db]').length`);
        check('ui: databases of both clusters listed', dbRows === 6, dbRows);
        const tunnelShown = await js(`[...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis'))?.textContent ?? ''`);
        check('ui: running tunnel shown on its database row', typeof tunnelShown === 'string' && /:\d+/.test(tunnelShown) && tunnelShown.includes('as default'), tunnelShown);
        const kubeRows = await js(`[...document.querySelectorAll('[data-testid=teleport-kube]')].map((r) => r.textContent)`);
        check('ui: kube clusters of both clusters with the active one', Array.isArray(kubeRows) && kubeRows.length === 3 && kubeRows.some((t: string) => t.includes('dev-eks') && t.includes('terminal')) && kubeRows.some((t: string) => t.includes('eu-eks')), kubeRows);
        await shot('09-teleport-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(300);
        await shot('10-teleport-light');
        // The pinned row's tick follows the terminal's kubectl context even while its cluster's section is collapsed
        // (and its kube list not loaded), e.g. when it changes from a terminal or an agent.
        const secondHeader = `document.querySelector('[data-testid=teleport-cluster][data-proxy="${fakeTsh.proxies.second}"] > [role=button]')`;
        await js(`${secondHeader}?.click()`);
        await wait(300);
        const collapsedKubes = await js(`[...document.querySelectorAll('[data-testid=teleport-kube]')].map((r) => r.textContent.trim().split(/\\s+/)[0])`);
        await run('teleport.kube.login', { proxy: fakeTsh.proxies.second, cluster: 'eu-eks' }, null);
        await wait(1500);
        const pinnedActive = await js(
          `[...document.querySelectorAll('[data-testid=teleport-pin]')].map((r) => [r.textContent.includes('eu-eks') ? 'eu-eks' : r.textContent.includes('smoke-redis') ? 'smoke-redis' : 'other', Boolean(r.querySelector('[aria-label=active]'))])`,
        );
        check(
          'ui: the pinned kube cluster the terminal points at is ticked, its cluster collapsed',
          Array.isArray(collapsedKubes) && !collapsedKubes.includes('eu-eks') && Array.isArray(pinnedActive) && pinnedActive.some((r: [string, boolean]) => r[0] === 'eu-eks' && r[1]) && pinnedActive.every((r: [string, boolean]) => r[0] === 'eu-eks' || !r[1]),
          { collapsedKubes, pinnedActive },
        );
        await js(`${secondHeader}?.click()`);
        await wait(800);
        // Switching the terminal to another kube cluster of the same Teleport cluster moves the tick and the "terminal" mark.
        await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-kube]')].find((r) => r.textContent.includes('dev-eks')); row?.querySelector('button[aria-label="Pin"]')?.click(); })()`,
        );
        await wait(1000);
        const tickOf = (name: string) => js(`Boolean([...document.querySelectorAll('[data-testid=teleport-pin]')].find((r) => r.textContent.includes('${name}'))?.querySelector('[aria-label=active]'))`);
        const devTickedBefore = await tickOf('dev-eks');
        await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-kube]')].find((r) => r.textContent.includes('prod-eks')); row?.querySelector('button[aria-label^="Set as kubectl context"]')?.click(); })()`,
        );
        await wait(300);
        await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Set terminal context')?.click()`);
        await wait(1500);
        const switched = {
          devTickedBefore,
          devTickedAfter: await tickOf('dev-eks'),
          euTicked: await tickOf('eu-eks'),
          terminalRows: await js(`[...document.querySelectorAll('[data-testid=teleport-kube]')].filter((r) => r.textContent.includes('terminal')).map((r) => r.textContent.replace('terminal', '').trim())`),
        };
        check(
          'ui: switching the terminal to another kube cluster clears the old tick',
          switched.devTickedBefore === true && switched.devTickedAfter === false && switched.euTicked === true && JSON.stringify(switched.terminalRows) === JSON.stringify(['prod-eks', 'eu-eks']),
          switched,
        );
        await shot('10b-teleport-kube-context');
        await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-pin]')].find((r) => r.textContent.includes('dev-eks')); row?.querySelector('button[aria-label="Unpin"]')?.click(); })()`,
        );
        await wait(1000);
        const clickedUnpin = await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-pin]')].find((r) => r.textContent.includes('second-mysql')); const btn = row && row.querySelector('button[aria-label="Unpin"]'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: unpin button on a pinned row', clickedUnpin === true);
        await wait(1000);
        const pinsAfter = await js(`document.querySelectorAll('[data-testid=teleport-pin]').length`);
        check('ui: unpin removes the row', pinsAfter === 2, pinsAfter);
        const clickedStop = await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis')); const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'); if (btn) btn.click(); return Boolean(btn); })()`,
        );
        check('ui: stop button on the tunnel row', clickedStop === true);
        await wait(1500);
        const afterStop = await js(`[...document.querySelectorAll('[data-testid=teleport-db]')].find((r) => r.textContent.includes('smoke-redis'))?.textContent ?? ''`);
        check('ui: row shows Connect after stopping', typeof afterStop === 'string' && !/:\d+/.test(afterStop), afterStop);
        const clickedConnect = await js(
          `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-pin]')].find((r) => r.textContent.includes('smoke-redis')); if (row) row.click(); return Boolean(row); })()`,
        );
        check('ui: connect from the pinned row', clickedConnect === true);
        await wait(2500);
        const revealed = await js(`(() => { const aside = document.querySelector('aside'); return aside ? aside.textContent.includes('Databases') && aside.textContent.includes('smoke-redis') : false; })()`);
        check('ui: connect reveals the connection in the Databases tree', revealed === true);
        const keysTabOpen = await js(`Boolean(document.querySelector('[data-tab-type="db.redis"]'))`);
        check('ui: connect opens the key browser', keysTabOpen === true);
        await shot('11-teleport-revealed-light');

        // Kubernetes query view: clicking a kube cluster opens it (no tsh kube login), the form builds the preview, Run shows the output.
        {
          const homeBeforeUi = await fs.readFile(fakeTsh.homeKubeconfig, 'utf8');
          await js(`(() => { const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.title || '') === 'Teleport'); if (btn) btn.click(); })()`);
          await wait(1200);
          const openedKube = await js(
            `(() => { const row = [...document.querySelectorAll('[data-testid=teleport-kube]')].find((r) => r.textContent.includes('prod-eks')); if (row) row.click(); return Boolean(row); })()`,
          );
          check('ui: clicking a kube cluster opens the query view', openedKube === true);
          await wait(1500);
          const viewCluster = await js(`document.querySelector('[data-testid=kube-query]')?.getAttribute('data-cluster') ?? null`);
          check('ui: query view is for the clicked cluster', viewCluster === 'prod-eks', viewCluster);
          // Set the value as a user would: the native setter, then the events a browser fires (a select fires input, then change).
          const setField = (testid: string, value: string) =>
            js(`(() => {
              const el = document.querySelector('[data-testid=${testid}]');
              if (!el) return false;
              const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              if (el instanceof HTMLSelectElement) el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()`);
          const text = (testid: string) => js(`document.querySelector('[data-testid=${testid}]')?.textContent ?? null`);
          const runDisabled = () => js(`document.querySelector('[data-testid=kube-run]')?.disabled ?? null`);
          // A misspelt namespace: kubectl would answer "No resources found" with exit 0, so the form warns and suggests the real one.
          await setField('kube-field-namespace', 'paymetns');
          await wait(300);
          const nsWarning = await text('kube-field-warning');
          check('ui: unknown namespace warns and suggests the closest one', typeof nsWarning === 'string' && nsWarning.includes('Not a namespace') && nsWarning.includes('Use payments?') && (await runDisabled()) === false, nsWarning);
          await js(`document.querySelector('[data-testid=kube-namespace-suggestion]').click()`);
          await wait(200);
          const nsFixed = await js(`document.querySelector('[data-testid=kube-field-namespace]')?.value ?? null`);
          check('ui: the suggestion fixes the namespace', nsFixed === 'payments' && (await text('kube-field-warning')) === null, nsFixed);
          // Success with a note on stderr ("No resources found") is not shown as an error.
          await setField('kube-field-resource', 'services');
          await wait(200);
          await js(`document.querySelector('[data-testid=kube-run]').click()`);
          await wait(1500);
          const emptyNote = await js(`(() => { const el = document.querySelector('[data-testid=kube-stderr]'); return el ? [el.textContent, el.className.includes('text-muted')] : null; })()`);
          check('ui: "No resources found" on success is a note, not an error', Array.isArray(emptyNote) && String(emptyNote[0]).includes('No resources found') && emptyNote[1] === true, emptyNote);
          await setField('kube-field-resource', 'pods');
          await wait(200);
          const listPreview = await text('kube-preview');
          const listExact = await js(`document.querySelector('[data-testid=kube-preview]')?.title ?? null`);
          check(
            'ui: preview is one short line, with the exact command as its tooltip',
            listPreview === 'kubectl get pods --namespace payments' &&
              typeof listExact === 'string' &&
              listExact.includes(' kubectl get pods --namespace payments --kubeconfig=') &&
              listExact.endsWith(' --context=smoke.teleport.local-prod-eks'),
            { listPreview, listExact },
          );
          const infoTip = await js(`document.querySelector('[data-testid=kube-info]')?.title ?? null`);
          check('ui: the explanation lives in the info tooltip', typeof infoTip === 'string' && infoTip.includes('Read-only') && infoTip.includes('kubectl get <type>'), infoTip);
          await js(`document.querySelector('[data-testid=kube-run]').click()`);
          await wait(1500);
          const outputText = await text('kube-output');
          const statusExit = await js(`document.querySelector('[data-testid=kube-status]')?.getAttribute('data-exit') ?? null`);
          check('ui: run shows the output with exit code', typeof outputText === 'string' && outputText.includes('api-7d9f-abc12') && statusExit === '0', { statusExit, outputText: String(outputText).slice(0, 120) });
          await setField('kube-search', 'worker');
          await wait(200);
          const matchText = await text('kube-matches');
          check('ui: output search counts matches', matchText === '1 match', matchText);
          await setField('kube-search', '');
          await js(`document.documentElement.classList.remove('dark')`);
          await wait(300);
          await shot('11b-kube-query-light');

          await setField('kube-operation', 'logs');
          await wait(200);
          await setField('kube-field-pod', '-bad');
          await wait(200);
          const podError = await js(`(() => { const input = document.querySelector('[data-testid=kube-field-pod]'); return input?.parentElement?.querySelector('.text-danger')?.textContent ?? null; })()`);
          check('ui: invalid value shows inline and disables Run', typeof podError === 'string' && podError.includes('-') && (await runDisabled()) === true, podError);
          await setField('kube-field-pod', 'api-7d9f-abc12');
          await wait(1500);
          const containerOptions = await js(`[...document.querySelectorAll('[data-testid=kube-field-container] option')].map((o) => o.value)`);
          check('ui: container picker filled from the pod', Array.isArray(containerOptions) && containerOptions.includes('api') && containerOptions.includes('istio-proxy'), containerOptions);
          await setField('kube-field-container', 'istio-proxy');
          await setField('kube-field-tail', '25');
          await wait(200);
          const logsPreview = await text('kube-preview');
          check('ui: logs preview', logsPreview === 'kubectl logs api-7d9f-abc12 --namespace payments --container istio-proxy --tail 25' && (await runDisabled()) === false, logsPreview);
          await js(`document.querySelector('[data-testid=kube-run]').click()`);
          await wait(1500);
          const logText = await text('kube-output');
          const ranHidden = (await text('kube-ran')) === null;
          await js(`document.querySelector('[data-testid=kube-ran-toggle]').click()`);
          await wait(200);
          const ranLine = await text('kube-ran');
          check(
            'ui: the exact command that ran is collapsed until asked for',
            ranHidden && typeof ranLine === 'string' && ranLine.includes(' kubectl logs api-7d9f-abc12 ') && ranLine.includes('--kubeconfig='),
            ranLine,
          );
          check('ui: logs rendered', typeof logText === 'string' && logText.includes('[istio-proxy] line 300') && !logText.includes('line 275\n'), String(logText).slice(-80));
          const historyRows = await js(`document.querySelectorAll('[data-testid=kube-history-entry]').length`);
          check('ui: history panel lists the runs', typeof historyRows === 'number' && historyRows >= 3, historyRows);
          await js(`document.documentElement.classList.add('dark')`);
          await wait(300);
          await shot('11c-kube-logs-dark');
          await js(`document.documentElement.classList.remove('dark')`);
          check('ui: the query view left the terminal kubeconfig alone', (await fs.readFile(fakeTsh.homeKubeconfig, 'utf8')) === homeBeforeUi);

          // Actions: their own group in the picker, styled apart, and every run through a confirmation with the exact command.
          {
            const groups = await js(`[...document.querySelectorAll('[data-testid=kube-operation] optgroup')].map((g) => [g.label, g.querySelectorAll('option').length])`);
            check('ui: the operation picker has a separate Actions group', Array.isArray(groups) && groups.length === 2 && groups[0][0] === 'Read' && String(groups[1][0]).startsWith('Actions') && groups[1][1] === 10, groups);
            await setField('kube-operation', 'scale');
            await wait(300);
            await setField('kube-field-name', 'api');
            await setField('kube-field-replicas', '0');
            await wait(500);
            const actionPreview = await text('kube-preview');
            const actionStyled = await js(`Boolean(document.querySelector('[data-testid=kube-action-banner]')) && document.querySelector('[data-testid=kube-run]')?.textContent.trim() === 'Run action…'`);
            check('ui: an action is styled apart and previews its kubectl line', actionStyled === true && actionPreview === 'kubectl scale deployments api --namespace payments --replicas 0', { actionStyled, actionPreview });
            const confirmState = () =>
              js(`(() => {
                const d = document.querySelector('[data-testid=kube-action-confirm]');
                if (!d) return null;
                return {
                  destructive: d.getAttribute('data-destructive'),
                  protected: d.getAttribute('data-protected'),
                  command: d.querySelector('[data-testid=kube-confirm-command]')?.textContent ?? '',
                  disabled: d.querySelector('[data-testid=kube-confirm-run]')?.disabled ?? null,
                  name: Boolean(d.querySelector('[data-testid=kube-confirm-name]')),
                  cluster: Boolean(d.querySelector('[data-testid=kube-confirm-cluster]')),
                };
              })()`) as Promise<{ destructive: string; protected: string; command: string; disabled: boolean; name: boolean; cluster: boolean } | null>;
            await js(`document.querySelector('[data-testid=kube-run]').click()`);
            await until(async () => (await confirmState()) !== null, 2000);
            const scaleDialog = await confirmState();
            check(
              'ui: Run opens a confirmation with the exact command, and scale to 0 needs the name typed',
              scaleDialog?.destructive === 'true' &&
                scaleDialog.command.includes(' kubectl scale deployments api --namespace payments --replicas 0 --kubeconfig=') &&
                scaleDialog.command.endsWith(' --context=smoke.teleport.local-prod-eks') &&
                scaleDialog.disabled === true &&
                scaleDialog.name &&
                !scaleDialog.cluster,
              scaleDialog,
            );
            await js(`document.documentElement.classList.add('dark')`);
            await wait(300);
            await shot('11d-kube-action-confirm-dark');
            await setField('kube-confirm-name', 'ap');
            await wait(100);
            const mistypedDisabled = (await confirmState())?.disabled;
            await setField('kube-confirm-name', 'api');
            await wait(100);
            const typedEnabled = (await confirmState())?.disabled === false;
            const callsBeforeUiAction = (await fakeTsh.kubectlCalls()).length;
            await js(`document.querySelector('[data-testid=kube-confirm-run]').click()`);
            await until(async () => String(await text('kube-output')).includes('scaled'), 3000);
            const uiActionCalls = await fakeTsh.kubectlCalls();
            check(
              'ui: typing the name enables Run; the action runs once and shows its output like a query',
              mistypedDisabled === true &&
                typedEnabled &&
                String(await text('kube-output')).includes('deployment.apps/api scaled') &&
                (await js(`document.querySelector('[data-testid=kube-status]')?.getAttribute('data-exit') ?? null`)) === '0' &&
                uiActionCalls.length === callsBeforeUiAction + 1 &&
                JSON.stringify(uiActionCalls.at(-1)?.argv.slice(0, -2)) === JSON.stringify(['scale', 'deployments', 'api', '--namespace', 'payments', '--replicas', '0']) &&
                (await confirmState()) === null,
              { mistypedDisabled, typedEnabled, calls: uiActionCalls.length - callsBeforeUiAction, argv: uiActionCalls.at(-1)?.argv },
            );
            await wait(500);
            const actionRow = await js(`document.querySelector('[data-testid=kube-history-entry][data-kind=action]')?.textContent ?? null`);
            check('ui: the action shows in the history, marked as an action', typeof actionRow === 'string' && actionRow.includes('Scale') && actionRow.includes('action') && actionRow.includes('deployments/api'), actionRow);

            // Protect the cluster from its context menu: the next action also needs the cluster's name typed.
            const openKubeMenu = () =>
              js(`(() => {
                const row = [...document.querySelectorAll('[data-testid=teleport-kube]')].find((r) => r.textContent.includes('prod-eks'));
                if (!row) return false;
                const box = row.getBoundingClientRect();
                row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 5 }));
                return true;
              })()`);
            const menuOpened = await openKubeMenu();
            await wait(300);
            const menuChecked = await js(`document.querySelector('[data-testid=kube-menu-protect]')?.getAttribute('aria-checked') ?? null`);
            await js(`document.querySelector('[data-testid=kube-menu-protect]')?.click()`);
            const protectedNow = await until(async () => (await js(`Boolean(document.querySelector('[data-testid=kube-protected]'))`)) === true, 2500);
            const rowProtected = await js(`[...document.querySelectorAll('[data-testid=teleport-kube]')].find((r) => r.textContent.includes('prod-eks'))?.getAttribute('data-protected') ?? null`);
            check(
              'ui: the protected toggle sits in the cluster\'s context menu and marks the row and the view',
              menuOpened === true && menuChecked === 'false' && protectedNow && rowProtected === 'true' && host.config.get().teleport.protectedKubes.some((k) => k.name === 'prod-eks'),
              { menuOpened, menuChecked, protectedNow, rowProtected },
            );
            await setField('kube-operation', 'rollout-restart');
            await wait(400);
            await js(`document.querySelector('[data-testid=kube-run]').click()`);
            await until(async () => (await confirmState()) !== null, 2000);
            const protectedDialog = await confirmState();
            await js(`document.documentElement.classList.remove('dark')`);
            await wait(300);
            await shot('11e-kube-protected-confirm-light');
            await setField('kube-confirm-cluster', 'prod-eks');
            await wait(100);
            const clusterEnabled = (await confirmState())?.disabled === false;
            await js(`document.querySelector('[data-testid=kube-confirm-run]').click()`);
            await until(async () => String(await text('kube-output')).includes('restarted'), 3000);
            check(
              'ui: on a protected cluster the confirmation asks for the cluster name, then the action runs',
              protectedDialog?.protected === 'true' && protectedDialog.cluster && !protectedDialog.name && protectedDialog.disabled === true && clusterEnabled && String(await text('kube-output')).includes('deployment.apps/api restarted'),
              { protectedDialog, clusterEnabled },
            );
            await openKubeMenu();
            await wait(300);
            await js(`document.querySelector('[data-testid=kube-menu-protect]')?.click()`);
            await wait(300);
            await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop protecting')?.click()`);
            const unprotected = await until(async () => (await js(`Boolean(document.querySelector('[data-testid=kube-protected]'))`)) === false, 2500);
            check('ui: unprotecting asks first, then clears the mark', unprotected && !host.config.get().teleport.protectedKubes.some((k) => k.name === 'prod-eks'), host.config.get().teleport.protectedKubes);

            // Port forwards panel: start one, see its local port, reach it, stop it.
            await js(`document.querySelector('[data-testid=kube-forward-new]').click()`);
            await wait(300);
            await setField('kube-forward-kind', 'services');
            await setField('kube-forward-name', 'api');
            await setField('kube-forward-remote', '80');
            await wait(200);
            await js(`document.querySelector('[data-testid=kube-forward-start]').click()`);
            const forwardShown = await until(async () => (await js(`document.querySelector('[data-testid=kube-forward]')?.getAttribute('data-state') ?? null`)) === 'running', 5000);
            const uiForwards = await run<KubePortForward[]>('teleport.kube.portForward.list', {}, null);
            const forwardRowText = await text('kube-forward');
            const uiBanner = uiForwards[0] ? await readBanner(uiForwards[0].localPort) : null;
            await js(`document.documentElement.classList.add('dark')`);
            await wait(300);
            await shot('11f-kube-forwards-dark');
            check(
              'ui: the Port forwards panel starts a forward and lists it with its local port',
              forwardShown && uiForwards.length === 1 && String(forwardRowText).includes('services/api:80') && String(forwardRowText).includes(`:${uiForwards[0].localPort}`) && uiBanner === 'fake port-forward services/api:80 in payments',
              { forwardShown, forwardRowText, uiBanner },
            );
            const uiForwardPid = (await fakeTsh.kubectlCalls()).findLast((c) => c.argv[0] === 'port-forward')?.pid;
            const stopClicked = await js(`(() => { const b = document.querySelector('[data-testid=kube-forward-stop]'); b?.click(); return Boolean(b); })()`);
            const forwardGone = await until(async () => (await js(`document.querySelectorAll('[data-testid=kube-forward]').length`)) === 0, 3000);
            check(
              'ui: Stop on a forward removes it and ends its process tree',
              stopClicked === true && forwardGone && (await run<KubePortForward[]>('teleport.kube.portForward.list', {}, null)).length === 0 && (await until(() => !processAlive(uiForwardPid), 5000)),
              { stopClicked, forwardGone, alive: processAlive(uiForwardPid) },
            );
            await js(`document.documentElement.classList.remove('dark')`);
            await setField('kube-operation', 'logs');
            await wait(300);
          }

          // Follow logs, then Stop: the form comes back and the process doing the work is gone.
          const followState = () => js(`document.querySelector('[data-testid=kube-status]')?.getAttribute('data-state') ?? null`);
          const lastFollowPid = async () => (await fakeTsh.kubectlCalls()).findLast((c) => c.argv.includes('--follow'))?.pid;
          await setField('kube-operation', 'logs-follow');
          await wait(300);
          await js(`document.querySelector('[data-testid=kube-run]').click()`);
          const following = await until(async () => (await followState()) === 'running' && String(await text('kube-output')).includes('[istio-proxy] line 302'), 4000);
          const uiFollowPid = await lastFollowPid();
          await js(`document.querySelector('[data-testid=kube-stop]').click()`);
          const formBack = await until(async () => (await js(`Boolean(document.querySelector('[data-testid=kube-run]'))`)) === true && (await followState()) !== 'running', 2500);
          check('ui: Stop ends a followed log and frees the form', following && formBack && (await until(() => !processAlive(uiFollowPid), 1000)), { following, formBack, alive: processAlive(uiFollowPid) });

          // Closing the tab while following stops it too; nothing is left running.
          await js(`document.querySelector('[data-testid=kube-run]').click()`);
          const followingAgain = await until(async () => (await followState()) === 'running' && (await lastFollowPid()) !== uiFollowPid, 4000);
          const tabFollowPid = await lastFollowPid();
          await js(`document.querySelector('[role=tab][aria-selected=true] [aria-label="Close tab"]').click()`);
          const tabGone = await until(async () => (await js(`Boolean(document.querySelector('[data-testid=kube-query]'))`)) === false, 1000);
          check('ui: closing the tab stops its followed log', followingAgain && tabGone && (await until(() => !processAlive(tabFollowPid), 2500)), { followingAgain, tabGone, alive: processAlive(tabFollowPid) });
        }
      },
      after: async () => {
        const outSecond = await run<TeleportStatus>('teleport.logout', { proxy: second }, null);
        check(
          'teleport: logout of one cluster keeps the other',
          clusterOf(outSecond, second)?.state === 'logged-out' && clusterOf(outSecond, first)?.state === 'logged-in' && !outSecond.tunnels.some((t) => t.proxy === second),
          outSecond.clusters.map((c) => [c.proxy, c.state]),
        );
        const removed = await run<TeleportStatus>('teleport.cluster.remove', { proxy: second }, null);
        check('teleport: cluster remove drops it and its pins', removed.clusters.length === 1 && removed.pins.every((p) => p.proxy === first), { clusters: removed.clusters.map((c) => c.proxy), pins: removed.pins });
        const loggedOut = await run<TeleportStatus>('teleport.logout', {}, null);
        check('teleport: logout of all clears every session and tunnel', loggedOut.state === 'logged-out' && loggedOut.clusters.every((c) => c.state === 'logged-out') && loggedOut.tunnels.length === 0, { state: loggedOut.state, tunnels: loggedOut.tunnels.length });
      },
    };
  },
});
