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
  recentWorkspaces: RecentWorkspace[];
  /** Workspace paths reopened on startup. */
  openWorkspaces: string[];
  globalVariables: Variable[];
  mcp: McpConfig;
  teleport: TeleportConfig;
  mock: MockConfig;
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
  clearLog(name: string): Promise<void>;
}

export interface WorkspaceApi extends WorkspaceInfo {
  store: StoreApi;
  getState<T>(key: string, fallback: T): Promise<T>;
  setState<T>(key: string, value: T): Promise<void>;
}

export interface SecretsApi {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

/** What the host (Electron main process, or a CLI) gives to commands. */
export interface HostApi {
  readonly version: string;
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

/** Events broadcast from host to UI. */
export interface HostEvents {
  'workspace.changed': { workspaces: WorkspaceInfo[] };
  'config.changed': { config: GlobalConfig };
  'store.changed': { workspaceId: string; collection: string };
  'state.changed': { workspaceId: string; key: string };
  'mcp.status': { running: boolean; port: number; error?: string };
  'mcp.call': { tool: string; workspaceId?: string; ok: boolean; durationMs: number; at: string };
  /** Teleport session status, login progress, pins or tunnel list changed. Fetch teleport.status for details. */
  'teleport.changed': { reason: 'status' | 'tunnels' | 'login' | 'pins' };
  /** A mock server started or stopped, its definition changed, or it captured requests. */
  'mock.changed': { workspaceId: string; serverId: string; reason: 'status' | 'requests' | 'servers' };
  /** A WebSocket or SSE connection changed state, its definition changed, or messages arrived. */
  'realtime.changed': { workspaceId: string; connectionId: string; reason: 'status' | 'messages' | 'connections' };
}

export type HostEventName = keyof HostEvents;

export interface HostEventMessage<E extends HostEventName = HostEventName> {
  event: E;
  payload: HostEvents[E];
}
