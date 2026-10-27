import { describe, expect, it } from 'vitest';
import { tokenizeShell } from '../curl';
import {
  aggregateState,
  buildClusters,
  dbKindForProtocol,
  findCluster,
  formatRemaining,
  isKubeProtected,
  TELEPORT_RENEW_SPACING_MS,
  isAutoRenewOn,
  isBrowserLoginLine,
  isLoginRequiredMessage,
  isPinned,
  loggedOutCluster,
  migrateTeleportConfig,
  nextRenewalAt,
  normalizeProxy,
  proxiesToAutoRenew,
  setAutoRenew,
  type TeleportClusterStatus,
  type TeleportRenewalRecord,
  parseTshDatabases,
  parseTshKubeClusters,
  parseTshStatus,
  proxiesToAutoLogin,
  proxyAddress,
  sameProxy,
  setKubeProtected,
  togglePin,
  tshSettingToArgv,
} from './teleport';

const profile = (url: string, validUntil: string, extra: Record<string, unknown> = {}) => ({
  profile_url: url,
  username: 'alice',
  cluster: url.replace(/^https:\/\//, '').replace(/:443$/, ''),
  roles: ['access', 'github-dev'],
  traits: { logins: ['alice'] },
  kubernetes_enabled: true,
  valid_until: validUntil,
  ...extra,
});

const now = new Date('2026-09-25T10:00:00Z');

describe('parseTshStatus', () => {
  it('reads the current profile and every other profile with their own expiry', () => {
    const out = JSON.stringify({
      active: profile('https://a.example.com:443', '2026-09-25T20:00:00+03:00', { kubernetes_cluster: 'dev-eks' }),
      profiles: [profile('https://b.example.com:443', '2026-09-22T12:42:01+03:00')],
    });
    const profiles = parseTshStatus(out, now);
    expect(profiles.map((p) => [p.proxy, p.state, p.current])).toEqual([
      ['a.example.com:443', 'logged-in', true],
      ['b.example.com:443', 'expired', false],
    ]);
    expect(profiles[0]).toMatchObject({ cluster: 'a.example.com', user: 'alice', roles: ['access', 'github-dev'], validUntil: '2026-09-25T17:00:00.000Z', kubeCluster: 'dev-eks' });
  });

  it('flags expiring soon', () => {
    expect(parseTshStatus(JSON.stringify({ active: profile('https://a:443', '2026-09-25T10:20:00Z'), profiles: [] }), now)[0].state).toBe('expiring');
  });

  it('treats empty or non-JSON output as no profiles', () => {
    expect(parseTshStatus('', now)).toEqual([]);
    expect(parseTshStatus('ERROR: Not logged in.\n', now)).toEqual([]);
    expect(parseTshStatus('{"active": null, "profiles": []}', now)).toEqual([]);
  });
});

describe('clusters', () => {
  const profiles = parseTshStatus(
    JSON.stringify({ active: profile('https://a.example.com:443', '2026-09-25T20:00:00Z'), profiles: [profile('https://b.example.com:443', '2026-09-22T12:00:00Z')] }),
    now,
  );

  it('merges configured proxies with tsh profiles, configured first', () => {
    const clusters = buildClusters(['B.example.com', 'c.example.com:3080'], profiles);
    expect(clusters.map((c) => [c.proxy, c.state, c.configured, c.current])).toEqual([
      ['B.example.com', 'expired', true, false],
      ['c.example.com:3080', 'logged-out', true, false],
      ['a.example.com:443', 'logged-in', false, true],
    ]);
    expect(aggregateState(clusters)).toBe('logged-in');
    expect(aggregateState(clusters.filter((c) => c.state !== 'logged-in'))).toBe('expired');
    expect(aggregateState([])).toBe('logged-out');
  });

  it('finds clusters by proxy, defaulting to the current one', () => {
    const clusters = buildClusters([], profiles);
    expect(findCluster(clusters, 'b.example.com')?.cluster).toBe('b.example.com');
    expect(findCluster(clusters, '')?.proxy).toBe('a.example.com:443');
    expect(findCluster(clusters, 'nope')).toBeUndefined();
  });

  it('normalizes proxies', () => {
    expect(normalizeProxy('https://A.example.com:443/')).toBe('a.example.com');
    expect(sameProxy('a.example.com', 'A.EXAMPLE.COM:443')).toBe(true);
    expect(sameProxy('a.example.com:3080', 'a.example.com')).toBe(false);
    expect(proxyAddress('https://a.b:443/')).toBe('a.b:443');
  });

  it('auto-logs in only expired clusters when enabled', () => {
    const clusters = buildClusters(['x.example.com'], profiles);
    expect(proxiesToAutoLogin({ loginOnLaunch: true }, clusters)).toEqual(['b.example.com:443']);
    expect(proxiesToAutoLogin({ loginOnLaunch: false }, clusters)).toEqual([]);
  });
});

describe('pins and config', () => {
  it('toggles pins without duplicates and matches proxies loosely', () => {
    let pins = togglePin([], { proxy: 'a.example.com:443', kind: 'db', name: 'orders' }, true);
    pins = togglePin(pins, { proxy: 'A.example.com', kind: 'db', name: 'orders' }, true);
    pins = togglePin(pins, { proxy: 'a.example.com:443', kind: 'kube', name: 'dev' }, true);
    expect(pins).toHaveLength(2);
    expect(isPinned(pins, 'db', 'a.example.com', 'orders')).toBe(true);
    expect(isPinned(pins, 'db', 'b.example.com', 'orders')).toBe(false);
    pins = togglePin(pins, { proxy: 'a.example.com', kind: 'db', name: 'orders' }, false);
    expect(pins).toEqual([{ proxy: 'a.example.com:443', kind: 'kube', name: 'dev' }]);
  });

  it('migrates the old single proxy setting', () => {
    expect(migrateTeleportConfig({ proxy: 'a.example.com:443', tshPath: '', loginOnLaunch: true })).toEqual({
      proxies: ['a.example.com:443'],
      pins: [],
      tshPath: '',
      loginOnLaunch: true,
      autoRenew: [],
      protectedKubes: [],
      agentActionsOnProtected: false,
    });
    expect(migrateTeleportConfig({ proxies: ['a.example.com:443'], proxy: 'A.example.com', pins: [{ proxy: 'x', kind: 'db', name: 'y' }] })).toEqual({
      proxies: ['a.example.com:443'],
      pins: [{ proxy: 'x', kind: 'db', name: 'y' }],
      tshPath: '',
      loginOnLaunch: false,
      autoRenew: [],
      protectedKubes: [],
      agentActionsOnProtected: false,
    });
    expect(migrateTeleportConfig({})).toEqual({ proxies: [], pins: [], tshPath: '', loginOnLaunch: false, autoRenew: [], protectedKubes: [], agentActionsOnProtected: false });
  });

  it('keeps protected Kubernetes clusters and drops malformed ones', () => {
    const raw = { protectedKubes: [{ proxy: 'a.example.com:443', name: 'prod' }, { proxy: 'a.example.com:443', name: '' }, { name: 'x' }, null], agentActionsOnProtected: 'yes' };
    const migrated = migrateTeleportConfig(raw as unknown as Parameters<typeof migrateTeleportConfig>[0]);
    expect(migrated.protectedKubes).toEqual([{ proxy: 'a.example.com:443', name: 'prod' }]);
    // Only a real true lets agents act on protected clusters.
    expect(migrated.agentActionsOnProtected).toBe(false);
  });

  it('marks and unmarks protected clusters per Teleport cluster', () => {
    let list = setKubeProtected([], { proxy: 'A.example.com', name: 'prod' }, true);
    list = setKubeProtected(list, { proxy: 'a.example.com:443', name: 'prod' }, true);
    list = setKubeProtected(list, { proxy: 'b.example.com', name: 'prod' }, true);
    expect(list).toHaveLength(2);
    expect(isKubeProtected(list, 'a.example.com:443', 'prod')).toBe(true);
    expect(isKubeProtected(list, 'a.example.com', 'dev')).toBe(false);
    list = setKubeProtected(list, { proxy: 'a.example.com', name: 'prod' }, false);
    expect(isKubeProtected(list, 'a.example.com', 'prod')).toBe(false);
    expect(isKubeProtected(list, 'b.example.com:443', 'prod')).toBe(true);
  });
});

describe('parseTshDatabases', () => {
  it('reads DatabaseV3 resources with allowed users', () => {
    const out = JSON.stringify([
      { kind: 'db', version: 'v3', metadata: { name: 'orders', description: 'Orders DB', labels: { env: 'prod' } }, spec: { protocol: 'mysql', uri: 'orders.internal:3306' }, users: { allowed: ['app', 'readonly'], denied: [] } },
      { kind: 'db', version: 'v3', metadata: { name: 'cache' }, spec: { protocol: 'redis', uri: 'cache:6379' }, users: { allowed: ['*'] } },
    ]);
    const dbs = parseTshDatabases(out);
    expect(dbs.map((d) => d.name)).toEqual(['cache', 'orders']);
    expect(dbs[1]).toMatchObject({ protocol: 'mysql', description: 'Orders DB', uri: 'orders.internal:3306', labels: { env: 'prod' }, allowedUsers: ['app', 'readonly'] });
    expect(dbs[0].allowedUsers).toEqual(['*']);
  });

  it('returns nothing for garbage', () => {
    expect(parseTshDatabases('ERROR: Not logged in.')).toEqual([]);
    expect(parseTshDatabases('{}')).toEqual([]);
  });
});

describe('parseTshKubeClusters', () => {
  it('reads names, labels and the selected flag', () => {
    const out = JSON.stringify([
      { kube_cluster_name: 'prod-eks', labels: { env: 'prod' }, selected: false },
      { kube_cluster_name: 'dev-eks', labels: {}, selected: true },
    ]);
    expect(parseTshKubeClusters(out)).toEqual([
      { name: 'dev-eks', labels: {}, selected: true },
      { name: 'prod-eks', labels: { env: 'prod' }, selected: false },
    ]);
  });
});

describe('helpers', () => {
  it('detects login-required messages', () => {
    expect(isLoginRequiredMessage('ERROR: Not logged in.')).toBe(true);
    expect(isLoginRequiredMessage('ERROR: Active profile expired.')).toBe(true);
    expect(isLoginRequiredMessage('x509: certificate has expired or is not yet valid')).toBe(true);
    expect(isLoginRequiredMessage('access denied to orders by user alice')).toBe(false);
    expect(isLoginRequiredMessage('connection refused')).toBe(false);
  });

  it('turns the tsh setting into argv', () => {
    const exists = (f: string) => f === 'C:\\Program Files\\Teleport Connect\\resources\\bin\\tsh.exe';
    expect(tshSettingToArgv('', exists, tokenizeShell)).toBeNull();
    expect(tshSettingToArgv('C:\\Program Files\\Teleport Connect\\resources\\bin\\tsh.exe', exists, tokenizeShell)).toEqual(['C:\\Program Files\\Teleport Connect\\resources\\bin\\tsh.exe']);
    expect(tshSettingToArgv('node C:/tmp/fake-tsh.cjs', exists, tokenizeShell)).toEqual(['node', 'C:/tmp/fake-tsh.cjs']);
  });

  it('maps protocols and formats time left', () => {
    expect(dbKindForProtocol('MySQL')).toBe('mysql');
    expect(dbKindForProtocol('postgres')).toBe('postgres');
    expect(dbKindForProtocol('mongodb')).toBeNull();
    expect(formatRemaining('2026-09-25T21:42:00Z', now)).toBe('11h 42m');
    expect(formatRemaining('2026-09-25T10:09:30Z', now)).toBe('9m');
    expect(formatRemaining('2026-09-27T12:00:00Z', now)).toBe('2d 2h');
    expect(formatRemaining('2026-09-25T09:00:00Z', now)).toBe('expired');
  });
});

describe('keep me logged in', () => {
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const defaultExpiry = (state: TeleportClusterStatus['state']) => (state === 'logged-out' ? null : at(state === 'expired' ? -5 : state === 'expiring' ? 10 : 600));
  const cluster = (proxy: string, state: TeleportClusterStatus['state'], validUntil: string | null = defaultExpiry(state)): TeleportClusterStatus => ({
    ...loggedOutCluster(proxy, true),
    cluster: proxy.replace(/:443$/, ''),
    user: state === 'logged-out' ? null : 'alice',
    validUntil,
    state,
  });
  const a = 'a.example.com:443';
  const b = 'b.example.com:443';
  const config = { autoRenew: [a, b] };
  const none = { loginRunning: false, records: {} };
  const record = (lastResult: TeleportRenewalRecord['lastResult'], minutesAgo: number, validUntil: string | null = null): TeleportRenewalRecord => ({ lastAttemptAt: at(-minutesAgo), lastResult, lastError: null, validUntil });

  it('picks expiring and expired clusters, never logged-in or logged-out ones', () => {
    expect(proxiesToAutoRenew(config, [cluster(a, 'expiring')], none, now)).toEqual([a]);
    expect(proxiesToAutoRenew(config, [cluster(a, 'expired')], none, now)).toEqual([a]);
    expect(proxiesToAutoRenew(config, [cluster(a, 'logged-in'), cluster(b, 'logged-out')], none, now)).toEqual([]);
  });

  it('never picks a cluster with the setting off, matching proxies loosely', () => {
    expect(proxiesToAutoRenew({ autoRenew: [] }, [cluster(a, 'expired')], none, now)).toEqual([]);
    expect(proxiesToAutoRenew({ autoRenew: ['B.example.com'] }, [cluster(a, 'expired'), cluster(b, 'expiring')], none, now)).toEqual([b]);
  });

  it('runs one at a time, the certificate that expires first', () => {
    const clusters = [cluster(a, 'expiring', at(20)), cluster(b, 'expired', at(-1))];
    expect(proxiesToAutoRenew(config, clusters, none, now)).toEqual([b]);
  });

  it('waits while any login is running', () => {
    expect(proxiesToAutoRenew(config, [cluster(a, 'expired')], { loginRunning: true, records: {} }, now)).toEqual([]);
  });

  it('spaces attempts on a cluster ten minutes apart, and not while one runs', () => {
    const clusters = [cluster(a, 'expiring')];
    const recent = { loginRunning: false, records: { [normalizeProxy(a)]: record('failed', 9) } };
    const older = { loginRunning: false, records: { [normalizeProxy(a)]: record('failed', TELEPORT_RENEW_SPACING_MS / 60_000) } };
    const running = { loginRunning: false, records: { [normalizeProxy(a)]: record(null, 30) } };
    expect(proxiesToAutoRenew(config, clusters, recent, now)).toEqual([]);
    expect(proxiesToAutoRenew(config, clusters, older, now)).toEqual([a]);
    expect(proxiesToAutoRenew(config, clusters, running, now)).toEqual([]);
    expect(nextRenewalAt(recent.records[normalizeProxy(a)], clusters[0])).toBe(at(1));
  });

  it('a spaced cluster does not hold back another one', () => {
    const clusters = [cluster(a, 'expired', at(-5)), cluster(b, 'expiring', at(10))];
    const state = { loginRunning: false, records: { [normalizeProxy(a)]: record('failed', 2) } };
    expect(proxiesToAutoRenew(config, clusters, state, now)).toEqual([b]);
  });

  it('a cancel holds until the certificate changes, then the new one gets an attempt at once', () => {
    const cert = at(10);
    const cancelled = { loginRunning: false, records: { [normalizeProxy(a)]: record('cancelled', 1, cert) } };
    expect(proxiesToAutoRenew(config, [cluster(a, 'expiring', cert)], cancelled, now)).toEqual([]);
    // Still the same certificate after it expired: still cancelled.
    expect(proxiesToAutoRenew(config, [cluster(a, 'expired', cert)], cancelled, now)).toEqual([]);
    expect(nextRenewalAt(cancelled.records[normalizeProxy(a)], cluster(a, 'expiring', cert))).toBeNull();
    // Another certificate (logged in elsewhere, then expiring again): not held back, not even by the spacing.
    expect(proxiesToAutoRenew(config, [cluster(a, 'expiring', at(15))], cancelled, now)).toEqual([a]);
  });

  it('turns the setting on and off without duplicates', () => {
    let list = setAutoRenew([], 'a.example.com', true);
    list = setAutoRenew(list, 'A.example.com:443', true);
    expect(list).toEqual(['A.example.com:443']);
    expect(isAutoRenewOn({ autoRenew: list }, a)).toBe(true);
    expect(setAutoRenew(list, a, false)).toEqual([]);
    expect(migrateTeleportConfig({ autoRenew: [a, 'A.example.com', '', 3 as unknown as string] }).autoRenew).toEqual([a]);
  });

  it('recognises the line tsh prints when it sends the user to the browser', () => {
    expect(isBrowserLoginLine('If browser window does not open automatically, open it by clicking on the link:')).toBe(true);
    expect(isBrowserLoginLine(' http://127.0.0.1:61234/abcd1234')).toBe(true);
    expect(isBrowserLoginLine('> Profile URL:        https://teleport.example.com:443')).toBe(false);
  });
});
