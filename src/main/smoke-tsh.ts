import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';

export interface FakeTshState {
  proxy: string;
  cluster: string;
  validUntil: string;
  kube: string | null;
}

export interface FakeTsh {
  /** Value for the `tshPath` setting: `"<node>" "<script>"`, tokenized by Quiver into argv. */
  command: string;
  stateFile: string;
  getState(): Promise<FakeTshState | null>;
  setState(state: FakeTshState | null): Promise<void>;
}

/**
 * A stand-in for the real tsh CLI, written as a Node script so the smoke test can exercise
 * login, status, db/kube listing and `proxy db --tunnel` without a Teleport cluster.
 * The tunnel is a plain TCP forwarder to the in-process fake Redis.
 */
export async function writeFakeTsh(dir: string, redisPort: number): Promise<FakeTsh> {
  const stateFile = path.join(dir, 'fake-tsh-state.json');
  const script = path.join(dir, 'fake-tsh.cjs');
  const source = FAKE_TSH_SOURCE.replace('__STATE_FILE__', JSON.stringify(stateFile)).replace('__REDIS_PORT__', String(redisPort));
  await fs.writeFile(script, source, 'utf8');
  const node = findNode();
  const quote = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  return {
    command: `${quote(node)} ${quote(script)}`,
    stateFile,
    getState: async () => {
      try {
        return JSON.parse(await fs.readFile(stateFile, 'utf8')) as FakeTshState;
      } catch {
        return null;
      }
    },
    setState: async (state) => {
      if (state) await fs.writeFile(stateFile, JSON.stringify(state), 'utf8');
      else await fs.rm(stateFile, { force: true });
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
const read = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const write = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s));
const expired = (s) => new Date(s.validUntil).getTime() <= Date.now();
const profile = (s) => ({
  profile_url: 'https://' + s.proxy,
  username: 'smoke-user',
  cluster: s.cluster,
  roles: ['access', 'github-dev'],
  traits: { logins: ['smoke-user'] },
  kubernetes_enabled: true,
  kubernetes_cluster: s.kube || undefined,
  valid_until: s.validUntil,
});
const requireLogin = () => {
  const s = read();
  if (!s) { err('ERROR: Not logged in.'); process.exit(1); }
  if (expired(s)) { err('ERROR: Active profile expired.'); process.exit(1); }
  return s;
};
const DBS = [
  { kind: 'db', version: 'v3', metadata: { name: 'smoke-redis', description: 'Fake Redis behind Teleport', labels: { env: 'smoke' } }, spec: { protocol: 'redis', uri: '127.0.0.1:6379' }, users: { allowed: ['default'], denied: [] } },
  { kind: 'db', version: 'v3', metadata: { name: 'orders-mysql', description: 'Orders', labels: { env: 'smoke' } }, spec: { protocol: 'mysql', uri: 'orders.internal:3306' }, users: { allowed: ['app', 'readonly'] } },
  { kind: 'db', version: 'v3', metadata: { name: 'analytics-pg', labels: {} }, spec: { protocol: 'postgres', uri: 'pg.internal:5432' }, users: { allowed: ['*'] } },
  { kind: 'db', version: 'v3', metadata: { name: 'broken-db' }, spec: { protocol: 'redis', uri: 'nowhere:6379' }, users: { allowed: ['default'] } },
];
const KUBES = ['dev-eks', 'prod-eks'];

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
    const s = read();
    if (!s) { err('ERROR: Not logged in.'); process.exit(1); }
    out(JSON.stringify({ active: profile(s), profiles: [] }, null, 2));
    if (expired(s)) { err('ERROR: Active profile expired.'); process.exit(1); }
    break;
  }
  case 'login': {
    const proxy = flag('proxy');
    if (!proxy) { err('ERROR: missing --proxy'); process.exit(1); }
    err('If browser window does not open automatically, open it by clicking on the link:');
    err(' http://127.0.0.1:61234/abcd1234');
    setTimeout(() => {
      const s = { proxy, cluster: proxy.replace(/:\d+$/, ''), validUntil: new Date(Date.now() + 12 * 3600 * 1000).toISOString(), kube: (read() || {}).kube || null };
      write(s);
      out('> Profile URL:        https://' + proxy);
      out('  Logged in as:       smoke-user');
      out('  Cluster:            ' + s.cluster);
      out('  Roles:              access, github-dev');
      out('  Valid until:        ' + s.validUntil);
      process.exit(0);
    }, 400);
    break;
  }
  case 'logout':
    try { fs.unlinkSync(STATE_FILE); } catch {}
    out('Logged out all users from all proxies.');
    break;
  case 'db':
    requireLogin();
    if (args[1] === 'ls') out(JSON.stringify(DBS));
    else { err('ERROR: unknown db subcommand ' + args[1]); process.exit(1); }
    break;
  case 'kube': {
    const s = requireLogin();
    if (args[1] === 'ls') {
      out(JSON.stringify(KUBES.map((k) => ({ kube_cluster_name: k, labels: { env: k.split('-')[0] }, selected: s.kube === k }))));
    } else if (args[1] === 'login') {
      const name = args[2];
      if (!KUBES.includes(name)) { err('ERROR: kubernetes cluster "' + name + '" not found'); process.exit(1); }
      write({ ...s, kube: name });
      out('Logged into Kubernetes cluster "' + name + '". Try \'kubectl version\' to test the connection.');
    } else { err('ERROR: unknown kube subcommand'); process.exit(1); }
    break;
  }
  case 'proxy': {
    const s = read();
    const db = args[2];
    const port = Number(flag('port'));
    const user = flag('db-user');
    if (!s) { err('ERROR: Not logged in.'); process.exit(1); }
    if (expired(s)) { err('ERROR: Your Teleport certificate has expired, please re-login with tsh login.'); process.exit(1); }
    const entry = DBS.find((d) => d.metadata.name === db);
    if (!entry || db === 'broken-db') { err('ERROR: database "' + db + '" not found, use tsh db ls'); process.exit(1); }
    if (!port || !user || !args.includes('--tunnel')) { err('ERROR: --tunnel, --port and --db-user are required'); process.exit(1); }
    forward(port, REDIS_PORT, () => out('Started authenticated tunnel for the ' + entry.spec.protocol + ' database "' + db + '" in cluster "' + s.cluster + '" on 127.0.0.1:' + port + '.'));
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
