import type { TeleportConfig, TeleportPin } from '../types';

/**
 * Teleport (goteleport.com) models and the pure parsers for `tsh --format=json` output.
 * Process spawning lives in the modules package; everything here is testable without tsh.
 *
 * A "cluster" in Quiver is a tsh profile, identified by its proxy address (`host:port`).
 * tsh keeps one *current* profile for bare commands in the terminal; Quiver never relies on
 * it and passes `--proxy` explicitly, so several clusters can be used at once.
 */

export type TeleportClusterState = 'logged-out' | 'expired' | 'logged-in' | 'expiring';
export type TeleportState = 'no-tsh' | TeleportClusterState;

/** Certificates with less than this left count as "expiring soon". */
export const TELEPORT_EXPIRING_SOON_MS = 30 * 60 * 1000;

export interface TeleportClusterStatus {
  /** Proxy address, the cluster's identity in Quiver (settings, pins, connections, tunnels). */
  proxy: string;
  /** Teleport cluster name from the profile, once logged in. */
  cluster: string | null;
  user: string | null;
  roles: string[];
  /** ISO timestamp of certificate expiry. */
  validUntil: string | null;
  /** Kubernetes cluster selected in this profile (`tsh kube login`). */
  kubeCluster: string | null;
  state: TeleportClusterState;
  /** tsh's current profile: what a bare `tsh` in the terminal talks to. */
  current: boolean;
  /** Listed in Settings, as opposed to only known from a tsh profile on disk. */
  configured: boolean;
}

export interface TeleportStatus {
  /** Aggregate over clusters: no-tsh, or the best state any cluster is in. */
  state: TeleportState;
  /** Resolved tsh command (path or wrapper argv), null when not found. */
  tsh: string[] | null;
  tshVersion: string | null;
  /** Where tsh came from: the settings value, PATH, or Teleport Connect's bundle. */
  tshSource: 'settings' | 'path' | 'connect' | null;
  clusters: TeleportClusterStatus[];
  loginInProgress: boolean;
  /** Proxy a running or last `tsh login` targets. */
  loginProxy: string | null;
  /** Last lines printed by `tsh login`, so browser links and MFA prompts are visible. */
  loginOutput: string[];
  pins: TeleportPin[];
  /** Last error from tsh, if the previous poll failed for a reason other than being logged out. */
  error: string | null;
  checkedAt: string;
  tunnels: TeleportTunnel[];
}

export interface TeleportDatabase {
  proxy: string;
  clusterName: string | null;
  name: string;
  /** mysql, postgres, redis, mongodb, ... as reported by Teleport. */
  protocol: string;
  description: string;
  uri: string;
  labels: Record<string, string>;
  /** Database users the current roles allow; `*` means any. */
  allowedUsers: string[];
  deniedUsers: string[];
  pinned: boolean;
  /** Running tunnel for this database, if any. */
  tunnel: TeleportTunnel | null;
}

export interface TeleportKubeCluster {
  proxy: string;
  name: string;
  labels: Record<string, string>;
  /** True for the cluster `tsh kube login` last selected in this profile. */
  selected: boolean;
  pinned: boolean;
}

export interface TeleportTunnel {
  id: string;
  kind: 'teleport' | 'command';
  /** Cluster the tunnel belongs to (empty for command tunnels). */
  proxy: string;
  /** Teleport database name, or the command line for command tunnels. */
  target: string;
  dbUser: string | null;
  port: number;
  pid: number | null;
  startedAt: string;
  /** Who holds it open: DB connections (`<workspaceId>/<connectionId>`) and explicit connects (`pinned`). */
  users: string[];
  /** Tail of stdout/stderr. */
  output: string[];
}

export interface TeleportLoginResult {
  ok: boolean;
  proxy: string;
  output: string[];
  status: TeleportStatus;
}

/** Shape of `tsh status --format=json`. Only the fields Quiver reads. */
interface TshProfileJson {
  profile_url?: string;
  username?: string;
  cluster?: string;
  roles?: string[] | null;
  valid_until?: string;
  kubernetes_cluster?: string;
  kubernetes_enabled?: boolean;
}

interface TshStatusJson {
  active?: TshProfileJson | null;
  profiles?: TshProfileJson[] | null;
}

export interface ParsedProfile {
  proxy: string;
  cluster: string | null;
  user: string | null;
  roles: string[];
  validUntil: string | null;
  kubeCluster: string | null;
  state: TeleportClusterState;
  current: boolean;
}

/** Strip the scheme and trailing slash from a profile URL: `https://x:443/` -> `x:443`. */
export function proxyAddress(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').trim() || null;
}

/** Proxies compare case-insensitively; `teleport.example.com` and `teleport.example.com:443` are the same cluster. */
export function normalizeProxy(proxy: string): string {
  const addr = (proxyAddress(proxy) ?? '').toLowerCase();
  return addr.endsWith(':443') ? addr.slice(0, -4) : addr;
}

export function sameProxy(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeProxy(a) === normalizeProxy(b);
}

function stateFor(validUntil: string | null, now: Date): TeleportClusterState {
  if (!validUntil) return 'logged-in';
  const remaining = new Date(validUntil).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return 'logged-in';
  if (remaining <= 0) return 'expired';
  if (remaining < TELEPORT_EXPIRING_SOON_MS) return 'expiring';
  return 'logged-in';
}

function parseProfile(p: TshProfileJson, current: boolean, now: Date): ParsedProfile | null {
  const proxy = proxyAddress(p.profile_url);
  if (!proxy) return null;
  const parsed = p.valid_until ? new Date(p.valid_until) : null;
  const validUntil = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
  return {
    proxy,
    cluster: p.cluster ?? null,
    user: p.username ?? null,
    roles: Array.isArray(p.roles) ? p.roles.map(String) : [],
    validUntil,
    kubeCluster: p.kubernetes_cluster || null,
    state: stateFor(validUntil, now),
    current,
  };
}

/**
 * Parse `tsh status --format=json`: the current profile under `active` plus every other
 * profile on disk under `profiles`, each with its own expiry. tsh prints the JSON even when
 * it then exits 1 with "Active profile expired.", and prints nothing when there is no profile.
 */
export function parseTshStatus(stdout: string, now: Date = new Date()): ParsedProfile[] {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return [];
  let json: TshStatusJson;
  try {
    json = JSON.parse(trimmed) as TshStatusJson;
  } catch {
    return [];
  }
  const out: ParsedProfile[] = [];
  const active = json.active ? parseProfile(json.active, true, now) : null;
  if (active) out.push(active);
  for (const p of json.profiles ?? []) {
    const parsed = p ? parseProfile(p, false, now) : null;
    if (parsed && !out.some((o) => sameProxy(o.proxy, parsed.proxy))) out.push(parsed);
  }
  return out;
}

/** Merge configured proxies with the profiles tsh knows: configured first, unknown ones as logged out. */
export function buildClusters(configuredProxies: string[], profiles: ParsedProfile[]): TeleportClusterStatus[] {
  const clusters: TeleportClusterStatus[] = [];
  for (const raw of configuredProxies) {
    const proxy = proxyAddress(raw);
    if (!proxy || clusters.some((c) => sameProxy(c.proxy, proxy))) continue;
    const profile = profiles.find((p) => sameProxy(p.proxy, proxy));
    clusters.push(
      profile
        ? { ...profile, proxy, configured: true }
        : { proxy, cluster: null, user: null, roles: [], validUntil: null, kubeCluster: null, state: 'logged-out', current: false, configured: true },
    );
  }
  for (const profile of profiles) {
    if (!clusters.some((c) => sameProxy(c.proxy, profile.proxy))) clusters.push({ ...profile, configured: false });
  }
  return clusters;
}

/** Best state across clusters, for the activity bar and one-line summaries. */
export function aggregateState(clusters: TeleportClusterStatus[]): TeleportClusterState {
  const usable = clusters.filter((c) => c.state === 'logged-in' || c.state === 'expiring');
  if (usable.length) return usable.some((c) => c.state === 'logged-in') ? 'logged-in' : 'expiring';
  if (clusters.some((c) => c.state === 'expired')) return 'expired';
  return 'logged-out';
}

/** Find a cluster by proxy; an empty proxy means tsh's current profile. */
export function findCluster(clusters: TeleportClusterStatus[], proxy: string | null | undefined): TeleportClusterStatus | undefined {
  if (!proxy) return clusters.find((c) => c.current) ?? (clusters.length === 1 ? clusters[0] : undefined);
  return clusters.find((c) => sameProxy(c.proxy, proxy));
}

/** Shape of one item of `tsh db ls --format=json` (a DatabaseV3 resource plus allowed users). */
interface TshDatabaseJson {
  metadata?: { name?: string; description?: string; labels?: Record<string, string> };
  spec?: { protocol?: string; uri?: string };
  users?: { allowed?: string[] | null; denied?: string[] | null } | null;
  // Older/alternate shapes.
  name?: string;
  protocol?: string;
}

export type ParsedDatabase = Omit<TeleportDatabase, 'tunnel' | 'pinned' | 'proxy' | 'clusterName'>;

export function parseTshDatabases(stdout: string): ParsedDatabase[] {
  const items = parseJsonArray<TshDatabaseJson>(stdout);
  return items
    .map((d) => ({
      name: d.metadata?.name ?? d.name ?? '',
      protocol: (d.spec?.protocol ?? d.protocol ?? '').toLowerCase(),
      description: d.metadata?.description ?? '',
      uri: d.spec?.uri ?? '',
      labels: d.metadata?.labels ?? {},
      allowedUsers: (d.users?.allowed ?? []).map(String),
      deniedUsers: (d.users?.denied ?? []).map(String),
    }))
    .filter((d) => d.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Shape of one item of `tsh kube ls --format=json`. */
interface TshKubeJson {
  kube_cluster_name?: string;
  name?: string;
  labels?: Record<string, string> | null;
  selected?: boolean;
}

export type ParsedKubeCluster = Omit<TeleportKubeCluster, 'proxy' | 'pinned'>;

export function parseTshKubeClusters(stdout: string): ParsedKubeCluster[] {
  return parseJsonArray<TshKubeJson>(stdout)
    .map((k) => ({ name: k.kube_cluster_name ?? k.name ?? '', labels: k.labels ?? {}, selected: Boolean(k.selected) }))
    .filter((k) => k.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseJsonArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('[')) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Does tsh output mean the certificate is gone and the user has to log in again? */
export function isLoginRequiredMessage(text: string): boolean {
  return /not logged in|profile expired|certificate has expired|cert(ificate)? (is )?expired|re-?login|please login|tsh login|expired credentials/i.test(text);
}

/**
 * Split the tsh setting into argv. A path to an existing file stays one token (it may
 * contain spaces); anything else is tokenized so a wrapper like `node fake-tsh.js` works.
 */
export function tshSettingToArgv(setting: string, exists: (file: string) => boolean, tokenize: (line: string) => string[]): string[] | null {
  const trimmed = setting.trim();
  if (!trimmed) return null;
  if (exists(trimmed)) return [trimmed];
  const argv = tokenize(trimmed);
  return argv.length ? argv : null;
}

/** Map a Teleport database protocol to a Quiver database kind, or null when Quiver has no client for it. */
export function dbKindForProtocol(protocol: string): 'mysql' | 'redis' | null {
  switch (protocol.toLowerCase()) {
    case 'mysql':
      return 'mysql';
    case 'redis':
      return 'redis';
    default:
      return null;
  }
}

/** Clusters to log into on launch: only sessions that existed and lapsed, never a fresh machine. */
export function proxiesToAutoLogin(config: Pick<TeleportConfig, 'loginOnLaunch'>, clusters: TeleportClusterStatus[]): string[] {
  if (!config.loginOnLaunch) return [];
  return clusters.filter((c) => c.state === 'expired').map((c) => c.proxy);
}

// ---------- pins ----------

export function isPinned(pins: TeleportPin[], kind: TeleportPin['kind'], proxy: string, name: string): boolean {
  return pins.some((p) => p.kind === kind && p.name === name && sameProxy(p.proxy, proxy));
}

/** Add or remove a pin, keeping the list free of duplicates and in insertion order. */
export function togglePin(pins: TeleportPin[], pin: TeleportPin, pinned: boolean): TeleportPin[] {
  const without = pins.filter((p) => !(p.kind === pin.kind && p.name === pin.name && sameProxy(p.proxy, pin.proxy)));
  return pinned ? [...without, { proxy: proxyAddress(pin.proxy) ?? pin.proxy, kind: pin.kind, name: pin.name }] : without;
}

/** Older configs had a single `proxy`; carry it into `proxies` and fill missing lists. */
export function migrateTeleportConfig(raw: Partial<TeleportConfig> & { proxy?: string }): TeleportConfig {
  const proxies = Array.isArray(raw.proxies) ? raw.proxies.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
  if (typeof raw.proxy === 'string' && raw.proxy.trim() && !proxies.some((p) => sameProxy(p, raw.proxy))) proxies.push(raw.proxy.trim());
  return {
    proxies,
    pins: Array.isArray(raw.pins) ? raw.pins.filter((p) => p && typeof p.proxy === 'string' && typeof p.name === 'string' && (p.kind === 'db' || p.kind === 'kube')) : [],
    tshPath: typeof raw.tshPath === 'string' ? raw.tshPath : '',
    loginOnLaunch: Boolean(raw.loginOnLaunch),
  };
}

/** Human-readable time left, e.g. "11h 42m", "9m", "expired". */
export function formatRemaining(validUntil: string | null, now: Date = new Date()): string {
  if (!validUntil) return '';
  const ms = new Date(validUntil).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d ${hours % 24}h`;
  return `${hours}h ${minutes % 60}m`;
}

/** Short label for a cluster: the Teleport cluster name, else the proxy host. */
export function clusterLabel(c: Pick<TeleportClusterStatus, 'proxy' | 'cluster'>): string {
  return c.cluster || c.proxy.replace(/:443$/, '');
}
