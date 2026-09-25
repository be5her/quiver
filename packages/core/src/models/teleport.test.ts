import { describe, expect, it } from 'vitest';
import { tokenizeShell } from '../curl';
import { dbKindForProtocol, formatRemaining, isLoginRequiredMessage, parseTshDatabases, parseTshKubeClusters, parseTshStatus, proxyAddress, shouldAutoLogin, tshSettingToArgv } from './teleport';

const statusJson = (validUntil: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    active: {
      profile_url: 'https://teleport.example.com:443',
      username: 'alice',
      cluster: 'teleport.example.com',
      roles: ['access', 'github-dev'],
      traits: { logins: ['alice'] },
      kubernetes_enabled: true,
      valid_until: validUntil,
      ...extra,
    },
    profiles: [{ profile_url: 'https://other.example.com:443', username: 'alice', cluster: 'other.example.com' }],
  });

describe('parseTshStatus', () => {
  const now = new Date('2026-09-25T10:00:00Z');

  it('reads a logged-in profile', () => {
    const s = parseTshStatus(statusJson('2026-09-25T20:00:00+03:00', { kubernetes_cluster: 'dev-eks' }), now);
    expect(s.state).toBe('logged-in');
    expect(s.proxy).toBe('teleport.example.com:443');
    expect(s.cluster).toBe('teleport.example.com');
    expect(s.user).toBe('alice');
    expect(s.roles).toEqual(['access', 'github-dev']);
    expect(s.validUntil).toBe('2026-09-25T17:00:00.000Z');
    expect(s.kubeCluster).toBe('dev-eks');
    expect(s.profiles).toEqual([{ proxy: 'other.example.com:443', cluster: 'other.example.com', user: 'alice' }]);
  });

  it('flags expiring soon and expired', () => {
    expect(parseTshStatus(statusJson('2026-09-25T10:20:00Z'), now).state).toBe('expiring');
    expect(parseTshStatus(statusJson('2026-09-22T12:42:01+03:00'), now).state).toBe('expired');
  });

  it('treats empty or non-JSON output as logged out', () => {
    expect(parseTshStatus('', now).state).toBe('logged-out');
    expect(parseTshStatus('ERROR: Not logged in.\n', now).state).toBe('logged-out');
    expect(parseTshStatus('{"active": null, "profiles": []}', now).state).toBe('logged-out');
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

  it('maps protocols and decides auto-login', () => {
    expect(dbKindForProtocol('MySQL')).toBe('mysql');
    expect(dbKindForProtocol('postgres')).toBeNull();
    expect(shouldAutoLogin({ loginOnLaunch: true, proxy: 'p:443' }, { state: 'expired', proxy: null })).toBe(true);
    expect(shouldAutoLogin({ loginOnLaunch: true, proxy: '' }, { state: 'expired', proxy: 'from-profile:443' })).toBe(true);
    expect(shouldAutoLogin({ loginOnLaunch: true, proxy: 'p:443' }, { state: 'logged-out', proxy: null })).toBe(false);
    expect(shouldAutoLogin({ loginOnLaunch: false, proxy: 'p:443' }, { state: 'expired', proxy: null })).toBe(false);
    expect(proxyAddress('https://a.b:443/')).toBe('a.b:443');
  });

  it('formats time left', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    expect(formatRemaining('2026-09-25T21:42:00Z', now)).toBe('11h 42m');
    expect(formatRemaining('2026-09-25T10:09:30Z', now)).toBe('9m');
    expect(formatRemaining('2026-09-27T12:00:00Z', now)).toBe('2d 2h');
    expect(formatRemaining('2026-09-25T09:00:00Z', now)).toBe('expired');
  });
});
