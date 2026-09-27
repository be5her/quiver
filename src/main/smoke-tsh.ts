import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';

export interface FakeTshProfile {
  cluster: string;
  validUntil: string;
  kube: string | null;
}

export interface FakeTshState {
  /** tsh's current profile (what a bare `tsh` uses). */
  current: string | null;
  profiles: Record<string, FakeTshProfile>;
}

export interface FakeTsh {
  /** Value for the `tshPath` setting: `"<node>" "<script>"`, tokenized by Quiver into argv. */
  command: string;
  stateFile: string;
  /** The two clusters the fake knows: databases and kube clusters differ per cluster. */
  proxies: { first: string; second: string };
  getState(): Promise<FakeTshState | null>;
  setState(state: FakeTshState | null): Promise<void>;
  /** Move a cluster's certificate into the past. */
  expire(proxy: string): Promise<void>;
  /** Stands in for the user's `~/.kube/config`; the smoke points KUBECONFIG at it. */
  homeKubeconfig: string;
  /** Every `tsh kubectl` call the fake received: argv after `kubectl`, and the KUBECONFIG it ran with. */
  kubectlCalls(): Promise<{ argv: string[]; kubeconfig: string | null }[]>;
}

/**
 * A stand-in for the real tsh CLI, written as a Node script so the smoke test can exercise
 * login, status, db/kube listing and `proxy db --tunnel` across two clusters without a
 * Teleport cluster. `--proxy` selects the profile like the real tsh; the tunnel is a plain
 * TCP forwarder to the in-process fake Redis. `kube login` writes the kubeconfig KUBECONFIG
 * names, and `kubectl` answers the read-only operations from canned data, logs every argv it
 * gets and refuses to run without a context from that kubeconfig.
 */
export async function writeFakeTsh(dir: string, redisPort: number): Promise<FakeTsh> {
  const stateFile = path.join(dir, 'fake-tsh-state.json');
  const script = path.join(dir, 'fake-tsh.cjs');
  const homeKubeconfig = path.join(dir, 'home-kubeconfig.yaml');
  const callsFile = path.join(dir, 'fake-kubectl-calls.jsonl');
  const source = FAKE_TSH_SOURCE.replace('__STATE_FILE__', JSON.stringify(stateFile))
    .replace('__REDIS_PORT__', String(redisPort))
    .replace('__HOME_KUBECONFIG__', JSON.stringify(homeKubeconfig))
    .replace('__CALLS_FILE__', JSON.stringify(callsFile));
  await fs.writeFile(script, source, 'utf8');
  const node = findNode();
  const quote = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const getState = async (): Promise<FakeTshState | null> => {
    try {
      return JSON.parse(await fs.readFile(stateFile, 'utf8')) as FakeTshState;
    } catch {
      return null;
    }
  };
  const setState = async (state: FakeTshState | null) => {
    if (state) await fs.writeFile(stateFile, JSON.stringify(state), 'utf8');
    else await fs.rm(stateFile, { force: true });
  };
  return {
    command: `${quote(node)} ${quote(script)}`,
    stateFile,
    proxies: { first: 'smoke.teleport.local:443', second: 'second.teleport.local:443' },
    getState,
    setState,
    expire: async (proxy) => {
      const state = await getState();
      if (!state?.profiles[proxy]) throw new Error(`fake tsh: no profile for ${proxy}`);
      state.profiles[proxy].validUntil = new Date(Date.now() - 60_000).toISOString();
      await setState(state);
    },
    homeKubeconfig,
    kubectlCalls: async () => {
      const text = await fs.readFile(callsFile, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { argv: string[]; kubeconfig: string | null });
    },
  };
}

/** `npm run smoke` always has node on PATH; resolve it to an absolute path so spawn needs no shell. */
export function findNode(): string {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return 'node';
}

const FAKE_TSH_SOURCE = String.raw`
const fs = require('fs');
const net = require('net');
const path = require('path');
const STATE_FILE = __STATE_FILE__;
const REDIS_PORT = __REDIS_PORT__;
const HOME_KUBECONFIG = __HOME_KUBECONFIG__;
const CALLS_FILE = __CALLS_FILE__;
const args = process.argv.slice(2);
const flag = (name) => { const a = args.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : undefined; };
const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');
const read = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { current: null, profiles: {} }; } };
const write = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s));
const expired = (p) => new Date(p.validUntil).getTime() <= Date.now();
const norm = (proxy) => String(proxy || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const findProxy = (state, proxy) => Object.keys(state.profiles).find((k) => norm(k) === norm(proxy));
const profile = (proxy, p) => ({
  profile_url: 'https://' + proxy,
  username: 'smoke-user',
  cluster: p.cluster,
  roles: ['access', 'github-dev'],
  traits: { logins: ['smoke-user'] },
  kubernetes_enabled: true,
  kubernetes_cluster: p.kube || undefined,
  valid_until: p.validUntil,
});
/** The profile a command targets: --proxy, else the current one. */
const selected = (state) => {
  const wanted = flag('proxy') || state.current;
  const key = wanted ? findProxy(state, wanted) : undefined;
  return key ? { proxy: key, p: state.profiles[key] } : null;
};
const requireLogin = () => {
  const state = read();
  const sel = selected(state);
  if (!sel) { err('ERROR: Not logged in.'); process.exit(1); }
  if (expired(sel.p)) { err('ERROR: Active profile expired.'); process.exit(1); }
  return { state, ...sel };
};
const DBS = {
  'smoke.teleport.local:443': [
    { kind: 'db', version: 'v3', metadata: { name: 'smoke-redis', description: 'Fake Redis behind Teleport', labels: { env: 'smoke' } }, spec: { protocol: 'redis', uri: '127.0.0.1:6379' }, users: { allowed: ['default'], denied: [] } },
    { kind: 'db', version: 'v3', metadata: { name: 'orders-mysql', description: 'Orders', labels: { env: 'smoke' } }, spec: { protocol: 'mysql', uri: 'orders.internal:3306' }, users: { allowed: ['app', 'readonly'] } },
    { kind: 'db', version: 'v3', metadata: { name: 'analytics-pg', labels: {} }, spec: { protocol: 'postgres', uri: 'pg.internal:5432' }, users: { allowed: ['*'] } },
    { kind: 'db', version: 'v3', metadata: { name: 'broken-db' }, spec: { protocol: 'redis', uri: 'nowhere:6379' }, users: { allowed: ['default'] } },
  ],
  'second.teleport.local:443': [
    { kind: 'db', version: 'v3', metadata: { name: 'second-redis', description: 'Redis on the second cluster', labels: { env: 'second' } }, spec: { protocol: 'redis', uri: '127.0.0.1:6379' }, users: { allowed: ['default'] } },
    { kind: 'db', version: 'v3', metadata: { name: 'second-mysql', labels: {} }, spec: { protocol: 'mysql', uri: 'db.second:3306' }, users: { allowed: ['app'] } },
  ],
};
const KUBES = { 'smoke.teleport.local:443': ['dev-eks', 'prod-eks'], 'second.teleport.local:443': ['eu-eks'] };
const dbsFor = (proxy) => DBS[Object.keys(DBS).find((k) => norm(k) === norm(proxy))] || [];
const kubesFor = (proxy) => KUBES[Object.keys(KUBES).find((k) => norm(k) === norm(proxy))] || [];

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** Kubeconfig as the fake writes it: one "- name: <ctx> # proxy=<proxy>" line per context. */
function readKubeconfig(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const contexts = {};
  for (const m of text.matchAll(/^- name: (\S+) # proxy=(\S+)$/gm)) contexts[m[1]] = m[2];
  const cur = /^current-context: (\S+)$/m.exec(text);
  return { contexts, current: cur ? cur[1] : null };
}
function writeKubeconfig(file, cfg) {
  const lines = ['apiVersion: v1', 'kind: Config', 'contexts:'];
  for (const [name, proxy] of Object.entries(cfg.contexts)) lines.push('- name: ' + name + ' # proxy=' + proxy);
  lines.push('current-context: ' + cfg.current, '');
  fs.writeFileSync(file, lines.join('\n'));
}
const K_NAMESPACES = ['default', 'kube-system', 'payments'];
const K_PODS = {
  payments: [
    { name: 'api-7d9f-abc12', containers: ['api', 'istio-proxy'], ready: '2/2', labels: { app: 'api' } },
    { name: 'worker-5c8b-xyz34', containers: ['worker'], ready: '1/1', labels: { app: 'worker' } },
  ],
  default: [{ name: 'hello-6b7c-q1w2e', containers: ['hello'], ready: '1/1', labels: { app: 'hello' } }],
  'kube-system': [{ name: 'coredns-5d78-aaaaa', containers: ['coredns'], ready: '1/1', labels: { k8s: 'dns' } }],
};
const K_DEPLOYMENTS = { payments: ['api', 'worker'], default: ['hello'], 'kube-system': ['coredns'] };
const K_WRITES = ['apply', 'create', 'delete', 'edit', 'patch', 'replace', 'scale', 'set', 'label', 'annotate', 'exec', 'cp', 'port-forward', 'proxy', 'run', 'drain', 'cordon', 'taint', 'debug', 'attach'];
const K_VALUE_FLAGS = ['--namespace', '--selector', '--output', '--container', '--tail', '--since', '--sort-by'];
const pad = (cells, widths) => cells.map((c, i) => String(c).padEnd(widths[i])).join(' ').trimEnd();
function table(header, rows) {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)) + 2);
  return [pad(header, widths), ...rows.map((r) => pad(r, widths))].join('\n');
}
function podsIn(opt) {
  const spaces = opt['all-namespaces'] ? K_NAMESPACES : [opt.namespace || 'default'];
  let pods = [];
  for (const ns of spaces) for (const pod of K_PODS[ns] || []) pods.push({ ns, ...pod });
  if (opt.selector) {
    const m = /^([\w.\/-]+)=([\w.-]*)$/.exec(opt.selector);
    if (m) pods = pods.filter((pod) => pod.labels[m[1]] === m[2]);
  }
  return pods;
}
function podJson(pod, ns) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: pod.name, namespace: ns, labels: pod.labels }, spec: { containers: pod.containers.map((c) => ({ name: c, image: c + ':1.0' })) }, status: { phase: 'Running' } };
}
function kubectl(argv) {
  let kubeconfig = null;
  let context = null;
  const rest = [];
  for (const a of argv) {
    if (a.startsWith('--kubeconfig=')) kubeconfig = a.slice('--kubeconfig='.length);
    else if (a.startsWith('--context=')) context = a.slice('--context='.length);
    else rest.push(a);
  }
  fs.appendFileSync(CALLS_FILE, JSON.stringify({ argv, kubeconfig: process.env.KUBECONFIG || null }) + '\n');
  const cfg = readKubeconfig(kubeconfig || process.env.KUBECONFIG || HOME_KUBECONFIG);
  const ctx = context || cfg.current;
  if (!ctx || !cfg.contexts[ctx]) { err('error: context "' + ctx + '" does not exist'); process.exit(1); }
  const state = read();
  const key = findProxy(state, cfg.contexts[ctx]);
  if (!key) { err('error: getting credentials: exec: ERROR: Not logged in.'); process.exit(1); }
  if (expired(state.profiles[key])) { err('error: getting credentials: exec: ERROR: Your Teleport certificate has expired, please re-login with tsh login.'); process.exit(1); }
  if (K_WRITES.includes(rest[0])) { err('FAKE KUBECTL: refusing write verb ' + rest[0]); process.exit(99); }
  const opt = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (K_VALUE_FLAGS.includes(a)) opt[a.slice(2)] = rest[++i];
      else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  const ns = opt.namespace || 'default';
  const findPod = (name) => (K_PODS[ns] || []).find((pod) => pod.name === name);
  const notFound = (kind, name) => { err('Error from server (NotFound): ' + kind + ' "' + name + '" not found'); process.exit(1); };
  switch (pos[0]) {
    case 'get': {
      const type = pos[1];
      const name = pos[2];
      if (type === 'pods') {
        if (name) {
          const pod = findPod(name);
          if (!pod) notFound('pods', name);
          if (opt.output === 'json') out(JSON.stringify(podJson(pod, ns), null, 2));
          else if (opt.output === 'yaml') out('apiVersion: v1\nkind: Pod\nmetadata:\n  name: ' + pod.name + '\n  namespace: ' + ns);
          else out(table(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'], [[pod.name, pod.ready, 'Running', 0, '3d']]));
          return;
        }
        const pods = podsIn(opt);
        if (!pods.length) { err('No resources found in ' + ns + ' namespace.'); return; }
        if (opt.output === 'json') return out(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: pods.map((pod) => podJson(pod, pod.ns)) }, null, 2));
        const all = Boolean(opt['all-namespaces']);
        const wide = opt.output === 'wide';
        const header = [...(all ? ['NAMESPACE'] : []), 'NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE'] : [])];
        out(table(header, pods.map((pod, i) => [...(all ? [pod.ns] : []), pod.name, pod.ready, 'Running', i, '3d', ...(wide ? ['10.0.1.' + (10 + i), 'ip-10-0-0-1'] : [])])));
        return;
      }
      if (type === 'namespaces') return out(table(['NAME', 'STATUS', 'AGE'], K_NAMESPACES.map((n) => [n, 'Active', '90d'])));
      if (type === 'deployments') {
        const deps = K_DEPLOYMENTS[ns] || [];
        if (name && !deps.includes(name)) notFound('deployments.apps', name);
        return out(table(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'], (name ? [name] : deps).map((d) => [d, '2/2', 2, 2, '12d'])));
      }
      if (type === 'nodes') return out(table(['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'], [['ip-10-0-0-1', 'Ready', '<none>', '40d', 'v1.29.3-eks']]));
      if (type === 'events') {
        return out(table(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], [
          ['5m', 'Normal', 'Scheduled', 'pod/api-7d9f-abc12', 'Successfully assigned ' + ns + '/api-7d9f-abc12'],
          ['2m', 'Warning', 'BackOff', 'pod/worker-5c8b-xyz34', 'Back-off restarting failed container'],
        ]));
      }
      if (name) notFound(type, name);
      err('No resources found in ' + ns + ' namespace.');
      return;
    }
    case 'describe': {
      const pod = pos[1] === 'pods' ? findPod(pos[2]) : null;
      if (!pod) notFound(pos[1], pos[2]);
      out(['Name:         ' + pod.name, 'Namespace:    ' + ns, 'Status:       Running', 'Containers:', ...pod.containers.map((c) => '  ' + c + ':\n    Image:  ' + c + ':1.0\n    State:  Running'), 'Events:       <none>'].join('\n'));
      return;
    }
    case 'logs': {
      const pod = findPod(pos[1]);
      if (!pod) notFound('pods', pos[1]);
      const container = opt.container || pod.containers[0];
      if (!pod.containers.includes(container)) { err('error: container ' + container + ' is not valid for pod ' + pod.name); process.exit(1); }
      const line = (i) => (opt.timestamps ? new Date(Date.UTC(2026, 8, 27, 10, 0, i)).toISOString() + ' ' : '') + '[' + container + (opt.previous ? ' previous' : '') + '] line ' + i;
      const total = 300;
      const tail = opt.tail ? Math.min(Number(opt.tail), total) : total;
      for (let i = total - tail + 1; i <= total; i++) out(line(i));
      if (opt.follow) {
        let i = total;
        setInterval(() => out(line(++i)), 150);
      }
      return;
    }
    case 'top':
      if (pos[1] === 'nodes') return out(table(['NAME', 'CPU(cores)', 'CPU%', 'MEMORY(bytes)', 'MEMORY%'], [['ip-10-0-0-1', '412m', '10%', '3120Mi', '41%']]));
      return out(table(['NAME', 'CPU(cores)', 'MEMORY(bytes)'], podsIn(opt).map((pod) => [pod.name, '12m', '96Mi'])));
    case 'rollout': {
      const name = pos[3];
      if (!(K_DEPLOYMENTS[ns] || []).includes(name)) notFound('deployments.apps', name);
      if (pos[1] === 'status') return out('deployment "' + name + '" successfully rolled out');
      return out('deployment.apps/' + name + '\nREVISION  CHANGE-CAUSE\n1         <none>\n2         <none>');
    }
    case 'api-resources':
      return out(table(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND'], [['pods', 'po', 'v1', 'true', 'Pod'], ['deployments', 'deploy', 'apps/v1', 'true', 'Deployment'], ['nodes', 'no', 'v1', 'false', 'Node']]));
    case 'version':
      return out('Client Version: v1.30.0-fake\nKustomize Version: v5.0.4\nServer Version: v1.29.3-eks');
    case 'auth':
      if (pos[1] !== 'can-i') break;
      if (['get', 'list', 'watch'].includes(pos[2])) return out('yes');
      out('no');
      process.exit(1);
  }
  err('error: unknown command "' + rest.join(' ') + '" for "kubectl"');
  process.exit(1);
}

function forward(port, target, onListen) {
  const server = net.createServer((sock) => {
    const up = net.connect(target, '127.0.0.1');
    sock.pipe(up).pipe(sock);
    sock.on('error', () => up.destroy());
    up.on('error', () => sock.destroy());
  });
  server.on('error', (e) => { err('ERROR: ' + e.message); process.exit(1); });
  server.listen(port, '127.0.0.1', onListen);
}

switch (args[0]) {
  case 'version':
    out('Teleport v16.0.0-fake git:fake go1.22');
    break;
  case 'status': {
    const state = read();
    const keys = Object.keys(state.profiles);
    if (!keys.length) { err('ERROR: Not logged in.'); process.exit(1); }
    const sel = selected(state) || { proxy: keys[0], p: state.profiles[keys[0]] };
    const others = keys.filter((k) => k !== sel.proxy).map((k) => profile(k, state.profiles[k]));
    out(JSON.stringify({ active: profile(sel.proxy, sel.p), profiles: others }, null, 2));
    if (expired(sel.p)) { err('ERROR: Active profile expired.'); process.exit(1); }
    break;
  }
  case 'login': {
    const proxy = flag('proxy');
    if (!proxy) { err('ERROR: missing --proxy'); process.exit(1); }
    err('If browser window does not open automatically, open it by clicking on the link:');
    err(' http://127.0.0.1:61234/abcd1234');
    setTimeout(() => {
      const state = read();
      const key = findProxy(state, proxy) || proxy;
      const previous = state.profiles[key] || {};
      state.profiles[key] = { cluster: proxy.replace(/:\d+$/, ''), validUntil: new Date(Date.now() + 12 * 3600 * 1000).toISOString(), kube: previous.kube || null };
      state.current = key;
      write(state);
      out('> Profile URL:        https://' + key);
      out('  Logged in as:       smoke-user');
      out('  Cluster:            ' + state.profiles[key].cluster);
      out('  Roles:              access, github-dev');
      out('  Valid until:        ' + state.profiles[key].validUntil);
      process.exit(0);
    }, 400);
    break;
  }
  case 'logout': {
    const state = read();
    const proxy = flag('proxy');
    if (proxy) {
      if (!flag('user')) { err('ERROR: specify --user to log out a specific user from a proxy'); process.exit(1); }
      const key = findProxy(state, proxy);
      if (key) delete state.profiles[key];
      if (state.current && norm(state.current) === norm(proxy)) state.current = Object.keys(state.profiles)[0] || null;
      write(state);
      out('Logged out ' + proxy + '.');
    } else {
      try { fs.unlinkSync(STATE_FILE); } catch {}
      out('Logged out all users from all proxies.');
    }
    break;
  }
  case 'db': {
    const { proxy } = requireLogin();
    if (args[1] === 'ls') out(JSON.stringify(dbsFor(proxy)));
    else { err('ERROR: unknown db subcommand ' + args[1]); process.exit(1); }
    break;
  }
  case 'kube': {
    const { state, proxy, p } = requireLogin();
    if (args[1] === 'ls') {
      out(JSON.stringify(kubesFor(proxy).map((k) => ({ kube_cluster_name: k, labels: { env: k.split('-')[0] }, selected: p.kube === k }))));
    } else if (args[1] === 'login') {
      const name = args[2];
      if (!kubesFor(proxy).includes(name)) { err('ERROR: kubernetes cluster "' + name + '" not found'); process.exit(1); }
      const target = process.env.KUBECONFIG || HOME_KUBECONFIG;
      const cfg = readKubeconfig(target);
      const ctx = p.cluster + '-' + name;
      cfg.contexts[ctx] = proxy;
      cfg.current = ctx;
      writeKubeconfig(target, cfg);
      // tsh status reports the kube cluster of the kubeconfig the terminal uses.
      if (samePath(target, HOME_KUBECONFIG)) { state.profiles[proxy].kube = name; write(state); }
      out('Logged into Kubernetes cluster "' + name + '". Try \'kubectl version\' to test the connection.');
    } else { err('ERROR: unknown kube subcommand'); process.exit(1); }
    break;
  }
  case 'proxy': {
    const state = read();
    const sel = selected(state);
    const db = args[2];
    const port = Number(flag('port'));
    const user = flag('db-user');
    if (!sel) { err('ERROR: Not logged in.'); process.exit(1); }
    if (expired(sel.p)) { err('ERROR: Your Teleport certificate has expired, please re-login with tsh login.'); process.exit(1); }
    const entry = dbsFor(sel.proxy).find((d) => d.metadata.name === db);
    if (!entry || db === 'broken-db') { err('ERROR: database "' + db + '" not found, use tsh db ls'); process.exit(1); }
    if (!port || !user || !args.includes('--tunnel')) { err('ERROR: --tunnel, --port and --db-user are required'); process.exit(1); }
    forward(port, REDIS_PORT, () => out('Started authenticated tunnel for the ' + entry.spec.protocol + ' database "' + db + '" in cluster "' + sel.p.cluster + '" on 127.0.0.1:' + port + '.'));
    break;
  }
  case 'kubectl':
    kubectl(args.slice(1));
    break;
  case '__forward':
    forward(Number(args[1]), Number(args[2]), () => out('forwarding ' + args[1] + ' -> ' + args[2]));
    break;
  default:
    err('ERROR: unknown command ' + args.join(' '));
    process.exit(1);
}
`;
