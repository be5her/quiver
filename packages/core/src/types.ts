import type { NetworkConfig } from './network';
import type { ActivityBarLayout } from './activity-bar';
import type { McpRecordingStatus } from './models/mcp-recording';
import type { LogsSession } from './models/logs';
import type { z } from 'zod';

export type Caller = 'ui' | 'mcp' | 'cli' | 'system';

export interface Entity {
  id: string;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string;
}

export interface RecentWorkspace extends WorkspaceInfo {
  lastOpenedAt: string;
}

export interface Variable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  /** Secret values are stored encrypted per machine, never in committed files. */
  secret?: boolean;
}

export interface McpConfig {
  enabled: boolean;
  port: number;
  /** When false, commands flagged `mutating` are refused for MCP callers. */
  allowMutating: boolean;
}

/** A favourite Teleport resource, shown at the top of the Teleport sidebar. */
export interface TeleportPin {
  /** Proxy address of the cluster the resource lives in. */
  proxy: string;
  kind: 'db' | 'kube';
  name: string;
}

/** App-wide Teleport settings. Sessions live in the standard tsh home, shared with the terminal. */
export interface TeleportConfig {
  /** Proxy addresses of the clusters to show, e.g. `teleport.example.com:443`. Profiles tsh already knows are added automatically. */
  proxies: string[];
  pins: TeleportPin[];
  /** Optional explicit tsh binary (or wrapper command). Empty means discover it. */
  tshPath: string;
  /** Start `tsh login` on launch for every cluster whose certificate has expired. */
  loginOnLaunch: boolean;
}

/** A port Quiver handed to a mock server on this machine. New servers in any project avoid every recorded port. */
export interface MockPortRecord {
  port: number;
  /** Folder of the workspace the server lives in. */
  workspace: string;
  serverId: string;
  name: string;
}

export interface MockConfig {
  ports: MockPortRecord[];
}

export interface GlobalConfig {
  theme: 'system' | 'light' | 'dark';
  /** Colour palette key from `PALETTES`; unknown keys fall back to the default. */
  palette: string;
  recentWorkspaces: RecentWorkspace[];
  /** Workspace paths reopened on startup. */
  openWorkspaces: string[];
  globalVariables: Variable[];
  mcp: McpConfig;
  teleport: TeleportConfig;
  mock: MockConfig;
  updates: UpdatesConfig;
  /** The user's order of the activity bar and the modules hidden from it. */
  activityBar: ActivityBarLayout;
  /** How the API client, realtime connections and GraphQL introspection reach the network: the proxy. */
  network: NetworkConfig;
}

/** Which releases the in-app updater follows. `beta` adds the Windows prereleases built from every merge to main. */
export type UpdateChannel = 'stable' | 'beta';

export interface UpdatesConfig {
  channel: UpdateChannel;
}

/** Storage exposed to commands. Implemented over the `.quiver` folder of a workspace. */
export interface StoreApi {
  list<T extends Entity>(collection: string): Promise<T[]>;
  get<T extends Entity>(collection: string, id: string): Promise<T | undefined>;
  put<T extends Entity>(collection: string, item: T): Promise<T>;
  remove(collection: string, id: string): Promise<boolean>;
  /** Per-machine, gitignored JSON documents under `.quiver/local`. */
  readLocal<T>(name: string, fallback: T): Promise<T>;
  writeLocal<T>(name: string, value: T): Promise<void>;
  /** Append-only JSON lines logs under `.quiver/local`. */
  appendLog(name: string, entry: unknown): Promise<void>;
  readLog<T>(name: string, limit: number): Promise<T[]>;
  /** Replaces a log with these entries, oldest first, in one step: a reader sees the old log or the new one, never part of either. */
  writeLog(name: string, entries: unknown[]): Promise<void>;
  clearLog(name: string): Promise<void>;
}

export interface WorkspaceApi extends WorkspaceInfo {
  store: StoreApi;
  getState<T>(key: string, fallback: T): Promise<T>;
  setState<T>(key: string, value: T): Promise<void>;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** The body as bytes, only when the request asked for `binary` (a file export); `text` is then empty. */
  bytes?: Uint8Array;
}

/**
 * Persistent browser sessions, one cookie jar per partition, kept by the host per machine (never in
 * the project). A sign-in happens in a window the user drives; requests then carry its cookies, and
 * cookies the answers set are kept.
 */
export interface WebSessionsApi {
  /**
   * Open a window on `url` in the partition and resolve true once `done` holds for a page that
   * finished loading, or false when the user closes the window first. A second call for the same
   * partition focuses the open window and shares its outcome.
   */
  signIn(options: { partition: string; url: string; title: string; done(url: string): boolean | Promise<boolean> }): Promise<boolean>;
  /** A request with the partition's cookies. `binary` answers with `bytes` instead of `text`, for downloads. */
  fetch(partition: string, url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; binary?: boolean }): Promise<WebResponse>;
  /** A cookie the partition holds for `url`, or null. */
  cookie(partition: string, url: string, name: string): Promise<string | null>;
  /** Forget everything the partition stored: cookies, storage and cache. */
  clear(partition: string): Promise<void>;
}

export interface SecretsApi {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

/** What the host (Electron main process, or a CLI) gives to commands. */
export interface HostApi {
  readonly version: string;
  /** Per-machine app data folder (the Electron user data folder). Absent in hosts without one; modules then keep that state in memory. */
  readonly dataDir?: string;
  /** Native dialogs, present when the host has a window. */
  dialogs?: {
    pickFile(options?: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | undefined>;
  };
  config: {
    get(): GlobalConfig;
    update(patch: Partial<GlobalConfig>): Promise<GlobalConfig>;
  };
  workspaces: {
    list(): WorkspaceInfo[];
    get(id: string): WorkspaceApi | undefined;
    open(path: string): Promise<WorkspaceApi>;
    close(id: string): Promise<void>;
    /** Opens a native folder picker when the host has a UI. */
    pickFolder?(): Promise<string | undefined>;
  };
  secrets: SecretsApi;
  /** Browser sessions for services that sign in through a web page. Present when the host has windows. */
  web?: WebSessionsApi;
  /** Broadcast an event to every UI surface. */
  emit<E extends HostEventName>(event: E, payload: HostEvents[E]): void;
}

export interface CommandContext {
  caller: Caller;
  workspace?: WorkspaceApi;
  host: HostApi;
}

export type AnyZodObject = z.ZodObject<z.ZodRawShape>;

export interface CommandDefinition<S extends AnyZodObject = AnyZodObject, O = unknown> {
  /** Dotted, stable id such as `api.request.send`. Becomes `api_request_send` as an MCP tool. */
  id: string;
  title: string;
  description: string;
  /** Workspace commands require an open workspace in the context. */
  scope: 'global' | 'workspace';
  /**
   * Destructive or externally visible side effects. Gated for agents.
   * A function decides per call (after input validation), e.g. a query runner that lets reads through.
   */
  mutating?: boolean | ((input: z.infer<S>, ctx: CommandContext) => boolean | Promise<boolean>);
  /** Hidden commands are plumbing: not listed in the palette or exposed over MCP. */
  hidden?: boolean;
  input: S;
  handler(input: z.infer<S>, ctx: CommandContext): Promise<O>;
}

export interface CommandMeta {
  id: string;
  module: string;
  title: string;
  description: string;
  scope: 'global' | 'workspace';
  /** True when the command may mutate; see `conditional` for commands that decide per call. */
  mutating: boolean;
  /** The command is only gated for some inputs, e.g. write statements in a query runner. */
  conditional: boolean;
  hidden: boolean;
  /** True when the command runs with an empty input object, so it can be triggered from a palette. */
  noInput: boolean;
}

export interface ModuleMain {
  id: string;
  commands: CommandDefinition[];
  /** Called once when the host has loaded its config, before workspaces reopen. Use for app-wide pollers. */
  onStart?(host: HostApi): Promise<void> | void;
  /** Called once on shutdown, after workspaces closed. Kill child processes here. */
  onStop?(host: HostApi): Promise<void> | void;
  /** Called once per workspace when it is opened. Use for listeners, pools, servers. */
  onWorkspaceOpen?(ws: WorkspaceApi, host: HostApi): Promise<void> | void;
  onWorkspaceClose?(ws: WorkspaceApi, host: HostApi): Promise<void> | void;
}

/** Where the in-app updater stands. Fed by electron-updater from the manifests of the GitHub release. */
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error';

export interface UpdateState {
  /** False in development builds; `reason` says why. */
  supported: boolean;
  /** True when this build can replace itself in place. Otherwise the UI links to `url` for a manual download. */
  installable: boolean;
  reason?: string;
  /** The running version. */
  current: string;
  status: UpdateStatus;
  /** The newer version, once one is known. */
  version?: string;
  releaseDate?: string;
  /** The release page on GitHub: notes, or the manual download. */
  url?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  error?: string;
  checkedAt?: string;
  /** Whether the last check was started by the user or by the launch timer. */
  trigger?: 'manual' | 'auto';
  /** The channel the next check follows, from the global config. */
  channel: UpdateChannel;
  /** True where beta builds are published and can install themselves: Windows installs, for now. */
  betaSupported: boolean;
}

/** Implemented by the Electron host; absent in smoke runs and in hosts without an updater. */
export interface UpdatesApi {
  state(): UpdateState;
  check(trigger: 'manual' | 'auto'): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<void>;
}

/** Events broadcast from host to UI. */
export interface HostEvents {
  'workspace.changed': { workspaces: WorkspaceInfo[] };
  'config.changed': { config: GlobalConfig };
  'store.changed': { workspaceId: string; collection: string };
  'state.changed': { workspaceId: string; key: string };
  'mcp.status': { running: boolean; port: number; error?: string };
  'mcp.call': { tool: string; workspaceId?: string; ok: boolean; durationMs: number; at: string };
  /** The recording of agent calls started, paused, ended or was dropped, or a call was recorded. Bursts of calls arrive as one event. */
  'mcp.recording': McpRecordingStatus;
  /** Teleport session status, login progress, pins or tunnel list changed. Fetch teleport.status for details. */
  'teleport.changed': { reason: 'status' | 'tunnels' | 'login' | 'pins' };
  /** Kubernetes queries: the local history changed, or a followed log stream has new lines or ended. */
  'teleport.kube.changed': { reason: 'history' | 'stream'; runId?: string };
  /**
   * API client: a collection run started, moved on or finished (`runId`; fetch api.run.get), a streamed response got items or
   * ended (`streamId`; read api.request.stream.read), or a download of a send given a `sendId` got further (`received` bytes).
   */
  'api.changed': { workspaceId: string; reason: 'run' | 'stream' | 'progress'; runId?: string; streamId?: string; sendId?: string; received?: number };
  /** A mock server started or stopped, its definition changed, or it captured requests. */
  'mock.changed': { workspaceId: string; serverId: string; reason: 'status' | 'requests' | 'servers' };
  /** A WebSocket or SSE connection changed state, its definition changed, or messages arrived. */
  'realtime.changed': { workspaceId: string; connectionId: string; reason: 'status' | 'messages' | 'connections' };
  /** MCP inspector: a server connected or dropped, its definition changed, its tool/resource/prompt lists changed, or the log grew. */
  'mcp.changed': { workspaceId: string; serverId: string; reason: 'status' | 'servers' | 'lists' | 'log' };
  /** Env files: a dotenv file or .gitignore changed on disk (from Quiver or outside), or a backup was taken. */
  'env.changed': { workspaceId: string; reason: 'files'; path?: string };
  /** Logs: a Grafana sign-in started, finished or ended (`session`, for every connection on that address), or the query history grew. */
  'logs.changed': { reason: 'session' | 'history'; grafanaUrl?: string; workspaceId?: string };
  /** The Grafana session for an address changed (signed in, out, or the check failed); Logs and Redis through Grafana share it. */
  'grafana.changed': { grafanaUrl: string; state: LogsSession['state'] };
  /** Metabase: a sign-in or key check for an address changed (`session`), an API key was stored or cleared on this machine (`secret`), or the query history grew (`history`). */
  'metabase.changed': { reason: 'session' | 'secret' | 'history'; url?: string; connectionId?: string; workspaceId?: string };
  /** The workspace's todo list changed. */
  'todo.changed': { workspaceId: string };
  /** Git: the working tree, index or HEAD changed (`status`), branches or refs moved (`branches`), the stashes changed (`stashes`), or the pull request list was refreshed (`prs`). */
  'git.changed': { workspaceId: string; reason: 'status' | 'branches' | 'stashes' | 'prs' };
  /** Process runner: saved tasks changed (`tasks`), a process changed state (`state`), or a run printed output (`output`, throttled). */
  'runner.changed': { workspaceId: string; reason: 'tasks' | 'state' | 'output'; taskId?: string; runId?: string };
  /** Queues: connections changed (`connections`), messages were produced or purged (`messages`), or a live consumer got messages or ended (`consumer`); `destination` when one topic or queue was touched. */
  'queues.changed': { workspaceId: string; reason: 'connections' | 'messages' | 'consumer'; connectionId?: string; consumerId?: string; destination?: string };
  /** The in-app updater moved: checking, a version found, download progress, downloaded, or an error. */
  'app.update': UpdateState;
}

export type HostEventName = keyof HostEvents;

export interface HostEventMessage<E extends HostEventName = HostEventName> {
  event: E;
  payload: HostEvents[E];
}
