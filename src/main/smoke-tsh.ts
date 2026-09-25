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
}

/**
 * A stand-in for the real tsh CLI, written as a Node script so the smoke test can exercise
 * login, status, db/kube listing and `proxy db --tunnel` across two clusters without a
 * Teleport cluster. `--proxy` selects the profile like the real tsh; the tunnel is a plain
 * TCP forwarder to the in-process fake Redis.
 */
export async function writeFakeTsh(dir: string, redisPort: number): Promise<FakeTsh> {
  const stateFile = path.join(dir, 'fake-tsh-state.json');
  const script = path.join(dir, 'fake-tsh.cjs');
  const source = FAKE_TSH_SOURCE.replace('__STATE_FILE__', JSON.stringify(stateFile)).replace('__REDIS_PORT__', String(redisPort));
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
  };
}

/** `npm run smoke` always has node on PATH; resolve it to an absolute path so spawn needs no shell. */
function findNode(): string {
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
const STATE_FILE = __STATE_FILE__;
const REDIS_PORT = __REDIS_PORT__;
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
      state.profiles[proxy].kube = name;
      write(state);
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
  case '__forward':
    forward(Number(args[1]), Number(args[2]), () => out('forwarding ' + args[1] + ' -> ' + args[2]));
    break;
  default:
    err('ERROR: unknown command ' + args.join(' '));
    process.exit(1);
}
`;
