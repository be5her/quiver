/**
 * Teleport (goteleport.com) models and the pure parsers for `tsh --format=json` output.
 * Process spawning lives in the modules package; everything here is testable without tsh.
 */

export type TeleportState = 'no-tsh' | 'logged-out' | 'expired' | 'logged-in' | 'expiring';

/** Certificates with less than this left count as "expiring soon". */
export const TELEPORT_EXPIRING_SOON_MS = 30 * 60 * 1000;

export interface TeleportStatus {
  state: TeleportState;
  /** Resolved tsh command (path or wrapper argv), null when not found. */
  tsh: string[] | null;
  tshVersion: string | null;
  /** Where tsh came from: the settings value, PATH, or Teleport Connect's bundle. */
  tshSource: 'settings' | 'path' | 'connect' | null;
  /** Proxy address from settings, else from the active profile. */
  proxy: string | null;
  cluster: string | null;
  user: string | null;
  roles: string[];
  /** ISO timestamp of certificate expiry. */
  validUntil: string | null;
  /** Kubernetes cluster selected in the profile (`tsh kube login`). */
  kubeCluster: string | null;
  /** Other profiles known to tsh (logged in earlier). */
  profiles: { proxy: string; cluster: string; user: string }[];
  loginInProgress: boolean;
  /** Last lines printed by `tsh login`, so browser links and MFA prompts are visible. */
  loginOutput: string[];
  /** Last error from tsh, if the previous poll failed for a reason other than being logged out. */
  error: string | null;
  checkedAt: string;
  tunnels: TeleportTunnel[];
}

export interface TeleportDatabase {
  name: string;
  /** mysql, postgres, redis, mongodb, ... as reported by Teleport. */
  protocol: string;
  description: string;
  uri: string;
  labels: Record<string, string>;
  /** Database users the current roles allow; `*` means any. */
  allowedUsers: string[];
  deniedUsers: string[];
  /** Running tunnel for this database, if any. */
  tunnel: TeleportTunnel | null;
}

export interface TeleportKubeCluster {
  name: string;
  labels: Record<string, string>;
  /** True for the cluster `tsh kube login` last selected. */
  selected: boolean;
}

export interface TeleportTunnel {
  id: string;
  kind: 'teleport' | 'command';
  /** Teleport database name, or the command line for command tunnels. */
  target: string;
  dbUser: string | null;
  port: number;
  pid: number | null;
  startedAt: string;
  /** Who holds it open: DB connections (`<workspaceId>/<connectionId>`) and the Teleport sidebar (`ui`). */
  users: string[];
  /** Tail of stdout/stderr. */
  output: string[];
}

export interface TeleportLoginResult {
  ok: boolean;
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

export interface ParsedTshStatus {
  state: Exclude<TeleportState, 'no-tsh'>;
  proxy: string | null;
  cluster: string | null;
  user: string | null;
  roles: string[];
  validUntil: string | null;
  kubeCluster: string | null;
  profiles: { proxy: string; cluster: string; user: string }[];
}

/** Strip the scheme and trailing slash from a profile URL: `https://x:443/` -> `x:443`. */
export function proxyAddress(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '') || null;
}

/**
 * Parse `tsh status --format=json`. tsh prints the JSON even when it then exits 1 with
 * "Active profile expired.", and prints nothing at all when there is no profile.
 */
export function parseTshStatus(stdout: string, now: Date = new Date()): ParsedTshStatus {
  const loggedOut: ParsedTshStatus = { state: 'logged-out', proxy: null, cluster: null, user: null, roles: [], validUntil: null, kubeCluster: null, profiles: [] };
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return loggedOut;
  let json: TshStatusJson;
  try {
    json = JSON.parse(trimmed) as TshStatusJson;
  } catch {
    return loggedOut;
  }
  const profiles = (json.profiles ?? [])
    .filter((p): p is TshProfileJson => Boolean(p))
    .map((p) => ({ proxy: proxyAddress(p.profile_url) ?? '', cluster: p.cluster ?? '', user: p.username ?? '' }));
  const active = json.active;
  if (!active) return { ...loggedOut, profiles };

  const validUntil = active.valid_until ? new Date(active.valid_until) : null;
  const validIso = validUntil && !Number.isNaN(validUntil.getTime()) ? validUntil.toISOString() : null;
  const remaining = validUntil && validIso ? validUntil.getTime() - now.getTime() : null;
  let state: ParsedTshStatus['state'] = 'logged-in';
  if (remaining !== null && remaining <= 0) state = 'expired';
  else if (remaining !== null && remaining < TELEPORT_EXPIRING_SOON_MS) state = 'expiring';

  return {
    state,
    proxy: proxyAddress(active.profile_url),
    cluster: active.cluster ?? null,
    user: active.username ?? null,
    roles: Array.isArray(active.roles) ? active.roles.map(String) : [],
    validUntil: validIso,
    kubeCluster: active.kubernetes_cluster || null,
    profiles,
  };
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

export function parseTshDatabases(stdout: string): Omit<TeleportDatabase, 'tunnel'>[] {
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

export function parseTshKubeClusters(stdout: string): TeleportKubeCluster[] {
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

/** Should the app start `tsh login` on launch? Only when a session existed and lapsed, never on a fresh machine. */
export function shouldAutoLogin(config: { loginOnLaunch: boolean; proxy: string }, status: Pick<TeleportStatus, 'state' | 'proxy'>): boolean {
  if (!config.loginOnLaunch) return false;
  if (status.state !== 'expired') return false;
  return Boolean(config.proxy || status.proxy);
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
