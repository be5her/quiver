import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AGENT_ACTIVITY_SIZE,
  AgentApprovals,
  CommandRegistry,
  McpRecorder,
  QuiverError,
  RingBuffer,
  decideAgentPermission,
  defineCommand,
  isValidRuleMatch,
  mcpRecordingFileName,
  ruleSpecificity,
  toErrorPayload,
  upsertRule,
  withWorkspaceRules,
  workspaceRulesFor,
  type AgentActivityEntry,
  type AgentPermissionRule,
  type Caller,
  type ErrorPayload,
  type GlobalConfig,
  type HostApi,
  type HostEventName,
  type HostEvents,
  type PendingApproval,
  type RecentWorkspace,
  type SecretsApi,
  type UpdateState,
  type UpdatesApi,
  type WebSessionsApi,
  type WorkspaceApi,
} from '@quiver/core';
import { GlobalStore, WorkspaceManager, workspaceIdFor, type WorkspaceSession } from '@quiver/core/node';
import { startMcpServer, type McpCallEntry, type RunningMcpServer } from '@quiver/mcp';
import { mainModules } from '@quiver/modules/main';
import { z } from 'zod';
import { CliAccess, cliCommands } from './cli-access';

export interface HostOptions {
  userDataDir: string;
  version: string;
  secrets: SecretsApi;
  broadcast(message: { event: HostEventName; payload: unknown }): void;
  pickFolder?(): Promise<string | undefined>;
  pickFile?(options?: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | undefined>;
  /** Native "save as" dialog; returns the chosen path, which may not exist yet. */
  pickSavePath?(options?: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | undefined>;
  /** Show a folder in the OS file manager; absent in smoke runs. */
  revealFolder?(folder: string): Promise<void>;
  /** In-app updates; absent in development and smoke runs. */
  updates?: UpdatesApi;
  /** Browser sessions for web sign-ins (Grafana). */
  web?: WebSessionsApi;
  /** An agent's call waits for the user: tell them when the window is not in front. Absent in smoke runs. */
  notifyApproval?(pending: PendingApproval): void;
  /** Serve MCP and the command line endpoint when the config enables them; false for the headless CLI, which runs commands in-process. */
  serve?: boolean;
  /** The folder of the packaged `quiver` shims, for Settings; absent in development. */
  cliShims?: string;
}

const ruleSchema = z.object({ match: z.string().trim().refine(isValidRuleMatch, 'a command id, a glob like git.* or *'), action: z.enum(['allow', 'ask', 'deny']) });

export interface InvokeOptions {
  caller: Caller;
  workspaceId?: string | null;
  /** Aborts when whoever asked stops waiting, e.g. the command line was interrupted. */
  signal?: AbortSignal;
}

export type InvokeOutcome = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

export class Host {
  readonly registry = new CommandRegistry();
  readonly config: GlobalStore;
  readonly workspaces: WorkspaceManager;
  readonly api: HostApi;
  private mcp: RunningMcpServer | null = null;
  /** The calls agents make to the MCP server, while the user records them. Lives across server restarts, in memory only. */
  readonly recorder = new McpRecorder({ onChange: () => this.recordingChanged() });
  private recordingTimer: NodeJS.Timeout | null = null;
  private recordingDirty = false;
  private activeWorkspaceId: string | null = null;
  /** Agent calls waiting for the user, and the tools allowed per agent until Quiver restarts. */
  readonly approvals = new AgentApprovals({
    onRequest: (pending) => {
      this.emit('mcp.approval.requested', pending);
      this.opts.notifyApproval?.(pending);
    },
    onChange: (pending) => this.emit('mcp.activity', { reason: 'approvals', pending: pending.length }),
  });
  /** The last MCP calls, always on: who called what, what the permissions decided and how it went. No arguments. */
  private readonly activity = new RingBuffer<AgentActivityEntry>(AGENT_ACTIVITY_SIZE);
  private activityTimer: NodeJS.Timeout | null = null;
  private activityDirty = false;
  /** The token and endpoint file the `quiver` command line connects with. */
  readonly cli: CliAccess;

  constructor(private readonly opts: HostOptions) {
    this.cli = new CliAccess(opts.userDataDir, opts.version);
    this.config = new GlobalStore(path.join(opts.userDataDir, 'config.json'), (config) => this.emit('config.changed', { config }));

    this.workspaces = new WorkspaceManager({
      onListChange: (workspaces) => this.emit('workspace.changed', { workspaces }),
      onStoreChange: (workspaceId, collection) => this.emit('store.changed', { workspaceId, collection }),
      onStateChange: (workspaceId, key) => this.emit('state.changed', { workspaceId, key }),
      onOpen: async (ws) => {
        for (const mod of this.registry.listModules()) await mod.onWorkspaceOpen?.(ws, this.api);
      },
      onClose: async (ws) => {
        for (const mod of this.registry.listModules()) await mod.onWorkspaceClose?.(ws, this.api);
      },
    });

    this.api = {
      version: opts.version,
      dataDir: opts.userDataDir,
      config: {
        get: () => this.config.get(),
        update: (patch) => this.config.update(patch),
      },
      workspaces: {
        list: () => this.workspaces.list(),
        get: (id) => this.workspaces.get(id),
        open: (folder) => this.openWorkspace(folder),
        close: (id) => this.closeWorkspace(id),
        pickFolder: opts.pickFolder,
      },
      secrets: opts.secrets,
      web: opts.web,
      emit: (event, payload) => this.emit(event, payload),
      dialogs: opts.pickFile ? { pickFile: opts.pickFile } : undefined,
      approvals: { request: (request, signal) => this.approvals.request(request, signal) },
    };

    this.registry.registerModule({ id: 'host', commands: this.hostCommands() });
    this.registry.registerModule({ id: 'cli', commands: cliCommands(this, this.cli, opts.cliShims) });
    for (const mod of mainModules) this.registry.registerModule(mod);
  }

  emit<E extends HostEventName>(event: E, payload: HostEvents[E]): void {
    this.opts.broadcast({ event, payload });
  }

  async start(): Promise<void> {
    const config = await this.config.load();
    for (const mod of this.registry.listModules()) {
      try {
        await mod.onStart?.(this.api);
      } catch (err) {
        console.warn(`[quiver] module ${mod.id} failed to start: ${(err as Error).message}`);
      }
    }
    for (const folder of config.openWorkspaces) {
      try {
        await this.workspaces.open(folder);
      } catch (err) {
        console.warn(`[quiver] could not reopen workspace ${folder}: ${(err as Error).message}`);
      }
    }
    this.activeWorkspaceId = this.workspaces.list()[0]?.id ?? null;
    if (config.mcp.enabled) await this.startMcp();
  }

  async stop(): Promise<void> {
    await this.stopMcp();
    await this.workspaces.closeAll();
    for (const mod of this.registry.listModules()) {
      try {
        await mod.onStop?.(this.api);
      } catch (err) {
        console.warn(`[quiver] module ${mod.id} failed to stop: ${(err as Error).message}`);
      }
    }
  }

  async invoke(id: string, input: unknown, options: InvokeOptions): Promise<InvokeOutcome> {
    try {
      const workspace = options.workspaceId ? this.workspaces.get(options.workspaceId) : undefined;
      if (options.workspaceId && !workspace) throw new QuiverError('NOT_FOUND', `Workspace ${options.workspaceId} is not open`);
      const result = await this.registry.execute(id, input, { caller: options.caller, host: this.api, workspace, signal: options.signal });
      return { ok: true, result };
    } catch (err) {
      if (!(err instanceof QuiverError)) console.error(`[quiver] command ${id} failed`, err);
      return { ok: false, error: toErrorPayload(err) };
    }
  }

  // ---------- workspaces ----------

  private async openWorkspace(folder: string, persist = true): Promise<WorkspaceSession> {
    const session = await this.workspaces.open(folder);
    if (persist) {
      const config = this.config.get();
      const recent: RecentWorkspace[] = [
        { id: session.id, path: session.path, name: session.name, lastOpenedAt: new Date().toISOString() },
        ...config.recentWorkspaces.filter((r) => r.path !== session.path),
      ].slice(0, 20);
      const open = config.openWorkspaces.includes(session.path) ? config.openWorkspaces : [...config.openWorkspaces, session.path];
      await this.config.update({ recentWorkspaces: recent, openWorkspaces: open });
    }
    this.activeWorkspaceId ??= session.id;
    return session;
  }

  private async closeWorkspace(id: string): Promise<void> {
    const session = this.workspaces.get(id);
    if (!session) return;
    await this.workspaces.close(id);
    const config = this.config.get();
    await this.config.update({ openWorkspaces: config.openWorkspaces.filter((p) => p !== session.path) });
    if (this.activeWorkspaceId === id) this.activeWorkspaceId = this.workspaces.list()[0]?.id ?? null;
  }

  /** Used by the MCP layer: `hint` is a path or id from the URL, otherwise the UI's active workspace. */
  async resolveWorkspace(hint: string | null): Promise<WorkspaceApi | undefined> {
    if (hint) {
      const byId = this.workspaces.get(hint);
      if (byId) return byId;
      const byPath = this.workspaces.get(workspaceIdFor(hint));
      if (byPath) return byPath;
      return this.openWorkspace(hint, false);
    }
    return (this.activeWorkspaceId && this.workspaces.get(this.activeWorkspaceId)) || this.workspaces.get(this.workspaces.list()[0]?.id ?? '');
  }

  // ---------- MCP ----------

  async startMcp(): Promise<void> {
    // The headless CLI never serves, also when a command it runs (mcp.restart, config.update) asks for it.
    if (this.opts.serve === false) return;
    await this.stopMcp();
    const { port } = this.config.get().mcp;
    try {
      this.mcp = await startMcpServer({
        registry: this.registry,
        host: this.api,
        port,
        version: this.opts.version,
        resolveWorkspace: (hint) => this.resolveWorkspace(hint),
        onCall: (entry) => this.recordActivity(entry),
        calls: this.recorder,
        cli: this.cli.endpoint(this),
      });
      await this.cli.publish(port);
      this.emit('mcp.status', { running: true, port });
      console.log(`[quiver] MCP server listening on ${this.mcp.url}`);
    } catch (err) {
      this.mcp = null;
      this.emit('mcp.status', { running: false, port, error: (err as Error).message });
      console.error(`[quiver] MCP server failed to start on port ${port}: ${(err as Error).message}`);
    }
  }

  async stopMcp(): Promise<void> {
    if (!this.mcp) return;
    await this.mcp.close();
    this.mcp = null;
    await this.cli.withdraw();
    this.emit('mcp.status', { running: false, port: this.config.get().mcp.port });
  }

  mcpStatus(): HostEvents['mcp.status'] {
    return { running: this.mcp !== null, port: this.config.get().mcp.port };
  }

  private recordActivity(entry: McpCallEntry): void {
    const { agent, decision, ...call } = entry;
    this.emit('mcp.call', { ...call, agent: agent.name, decision });
    const ws = entry.workspaceId ? this.workspaces.get(entry.workspaceId) : undefined;
    this.activity.push({
      id: this.activity.last + 1,
      at: entry.at,
      agent: { name: agent.name, version: agent.version },
      tool: entry.tool,
      workspace: ws ? { id: ws.id, name: ws.name } : null,
      decision,
      ok: entry.ok,
      durationMs: entry.durationMs,
    });
    this.activityChanged();
  }

  /** Tells the UI about a call at once, then at most every 250 ms while calls keep arriving. */
  private activityChanged(): void {
    if (this.activityTimer) {
      this.activityDirty = true;
      return;
    }
    this.emit('mcp.activity', { reason: 'call', pending: this.approvals.list().length });
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (!this.activityDirty) return;
      this.activityDirty = false;
      this.activityChanged();
    }, 250);
    this.activityTimer.unref();
  }

  /** A workspace's rules live in the global config, per machine: never in the project, where anyone who can commit could plant an allow. */
  private async writeWorkspaceRules(workspaceId: string, rules: AgentPermissionRule[]): Promise<{ rules: AgentPermissionRule[] }> {
    const mcp = this.config.get().mcp;
    const saved = await this.config.update({ mcp: { ...mcp, workspaceRules: withWorkspaceRules(mcp, workspaceId, rules) } });
    return { rules: workspaceRulesFor(saved.mcp, workspaceId) };
  }

  /**
   * Where "Always allow" puts its rule for a waiting call: the workspace's rules when one of them matches the tool (it
   * would beat a global allow), otherwise the global rules.
   */
  private allowLevel(pending: PendingApproval): 'workspace' | 'global' {
    // A workspace allow does not count for a global command, so its rule goes in the global ones.
    if (!pending.workspace || this.scopeOf(pending.commandId) !== 'workspace') return 'global';
    const wsRules = workspaceRulesFor(this.config.get().mcp, pending.workspace.id);
    return wsRules.some((r) => ruleSpecificity(r.match, pending.commandId) >= 0) ? 'workspace' : 'global';
  }

  private scopeOf(commandId: string): 'global' | 'workspace' {
    return this.registry.get(commandId)?.command.scope ?? 'global';
  }

  /** The MCP section with an allow rule for a waiting call's tool added at that level. */
  private withAllowRule(pending: PendingApproval, level: 'workspace' | 'global'): GlobalConfig['mcp'] {
    const mcp = this.config.get().mcp;
    const rule = { match: pending.commandId, action: 'allow' as const };
    if (level === 'workspace' && pending.workspace) {
      return { ...mcp, workspaceRules: withWorkspaceRules(mcp, pending.workspace.id, upsertRule(workspaceRulesFor(mcp, pending.workspace.id), rule)) };
    }
    return { ...mcp, permissions: { ...mcp.permissions, rules: upsertRule(mcp.permissions.rules, rule) } };
  }

  /** Whether an MCP section lets a waiting call through without asking, as the registry would decide it. */
  private allowedBy(mcp: GlobalConfig['mcp'], pending: PendingApproval): boolean {
    const workspaceRules = workspaceRulesFor(mcp, pending.workspace?.id, this.scopeOf(pending.commandId));
    return decideAgentPermission({ commandId: pending.commandId, mutating: pending.mutating, permissions: mcp.permissions, workspaceRules }).action === 'allow';
  }

  /** Pauses or resumes every agent; pausing also refuses the calls that wait for an answer. */
  private async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    await this.config.update({ mcp: { ...this.config.get().mcp, paused } });
    if (paused) this.approvals.refuseAll('paused');
    return { paused };
  }

  /** Tells the UI about the recording at once, then at most every 150 ms while calls keep arriving. */
  private recordingChanged(): void {
    if (this.recordingTimer) {
      this.recordingDirty = true;
      return;
    }
    this.emit('mcp.recording', this.recorder.status());
    this.recordingTimer = setTimeout(() => {
      this.recordingTimer = null;
      if (!this.recordingDirty) return;
      this.recordingDirty = false;
      this.recordingChanged();
    }, 150);
    this.recordingTimer.unref();
  }

  private updateState(): UpdateState {
    return (
      this.opts.updates?.state() ?? {
        supported: false,
        installable: false,
        reason: 'Updates are only checked in installed builds.',
        current: this.opts.version,
        status: 'idle',
        channel: this.config.get().updates.channel,
        betaSupported: false,
      }
    );
  }

  // ---------- host commands ----------

  private hostCommands() {
    return [
      defineCommand({
        id: 'workspace.list',
        title: 'List open workspaces',
        description: 'Lists workspaces currently open in Quiver.',
        scope: 'global',
        input: z.object({}),
        handler: async () => this.workspaces.list(),
      }),
      defineCommand({
        id: 'workspace.open',
        title: 'Open workspace folder',
        description: 'Opens a project folder as a workspace. Without a path the UI shows a folder picker.',
        scope: 'global',
        input: z.object({ path: z.string().optional() }),
        handler: async ({ path: folder }, ctx) => {
          let target = folder;
          if (!target) {
            if (ctx.caller !== 'ui' || !this.opts.pickFolder) throw new QuiverError('INVALID_INPUT', 'A folder path is required');
            target = await this.opts.pickFolder();
            if (!target) return null;
          }
          const session = await this.openWorkspace(target);
          return session.info();
        },
      }),
      defineCommand({
        id: 'workspace.reveal',
        title: 'Reveal workspace folder',
        description: 'Opens the workspace folder in the file manager.',
        scope: 'global',
        hidden: true,
        input: z.object({ id: z.string() }),
        handler: async ({ id }, ctx) => {
          const session = this.workspaces.get(id);
          if (!session) throw new QuiverError('NOT_FOUND', `No open workspace ${id}`);
          if (ctx.caller !== 'ui') throw new QuiverError('INVALID_INPUT', 'Revealing a folder is only available from the UI');
          await this.opts.revealFolder?.(session.path);
          return { path: session.path, revealed: Boolean(this.opts.revealFolder) };
        },
      }),
      defineCommand({
        id: 'workspace.close',
        title: 'Close workspace',
        description: 'Closes an open workspace.',
        scope: 'global',
        input: z.object({ id: z.string() }),
        handler: async ({ id }) => {
          await this.closeWorkspace(id);
          return { closed: true };
        },
      }),
      defineCommand({
        id: 'workspace.reorder',
        title: 'Reorder workspaces',
        description: 'Puts the open workspaces in the given order, which is also the order they reopen in.',
        scope: 'global',
        hidden: true,
        input: z.object({ ids: z.array(z.string()) }),
        handler: async ({ ids }) => {
          const list = this.workspaces.reorder(ids);
          const open = this.config.get().openWorkspaces;
          const ordered = list.map((w) => w.path).filter((p) => open.includes(p));
          await this.config.update({ openWorkspaces: [...ordered, ...open.filter((p) => !ordered.includes(p))] });
          return list;
        },
      }),
      defineCommand({
        id: 'workspace.recent',
        title: 'Recent workspaces',
        description: 'Lists recently opened workspace folders.',
        scope: 'global',
        input: z.object({}),
        handler: async () => this.config.get().recentWorkspaces,
      }),
      defineCommand({
        id: 'workspace.forgetRecent',
        title: 'Remove from recent workspaces',
        description: 'Removes a folder from the recent list.',
        scope: 'global',
        hidden: true,
        input: z.object({ path: z.string() }),
        handler: async ({ path: folder }) => {
          await this.config.update({ recentWorkspaces: this.config.get().recentWorkspaces.filter((r) => r.path !== folder) });
          return { ok: true };
        },
      }),
      defineCommand({
        id: 'workspace.setActive',
        title: 'Set active workspace',
        description: 'Tells the host which workspace the UI is showing. MCP clients without an explicit workspace use it.',
        scope: 'global',
        hidden: true,
        input: z.object({ id: z.string().nullable() }),
        handler: async ({ id }) => {
          this.activeWorkspaceId = id;
          return { id };
        },
      }),
      defineCommand({
        id: 'workspace.state.get',
        title: 'Read workspace UI state',
        description: 'Reads a per-machine state value for the workspace.',
        scope: 'workspace',
        hidden: true,
        input: z.object({ key: z.string() }),
        handler: async ({ key }, ctx) => ({ value: await ctx.workspace!.getState<unknown>(key, null) }),
      }),
      defineCommand({
        id: 'workspace.state.set',
        title: 'Write workspace UI state',
        description: 'Writes a per-machine state value for the workspace.',
        scope: 'workspace',
        hidden: true,
        input: z.object({ key: z.string(), value: z.unknown() }),
        handler: async ({ key, value }, ctx) => {
          await ctx.workspace!.setState(key, value);
          return { ok: true };
        },
      }),
      defineCommand({
        id: 'config.get',
        title: 'Read global config',
        description: 'Returns global configuration.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.config.get(),
      }),
      defineCommand({
        id: 'config.update',
        title: 'Update global config',
        description: 'Merges a patch into global configuration.',
        scope: 'global',
        hidden: true,
        input: z.object({ patch: z.record(z.string(), z.unknown()) }),
        handler: async ({ patch }) => {
          const before = this.config.get().mcp;
          const next = await this.config.update(patch as Partial<GlobalConfig>);
          if (next.mcp.enabled !== before.enabled || next.mcp.port !== before.port) {
            if (next.mcp.enabled) await this.startMcp();
            else await this.stopMcp();
          }
          return next;
        },
      }),
      defineCommand({
        id: 'app.pickFile',
        title: 'Pick a file',
        description: 'Opens a native file picker and returns the chosen path.',
        scope: 'global',
        hidden: true,
        input: z.object({
          title: z.string().optional(),
          filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional(),
          defaultPath: z.string().optional(),
        }),
        handler: async (input, ctx) => {
          if (ctx.caller !== 'ui' || !this.opts.pickFile) throw new QuiverError('INVALID_INPUT', 'File picker is only available from the UI');
          return { path: (await this.opts.pickFile(input)) ?? null };
        },
      }),
      defineCommand({
        id: 'app.pickSavePath',
        title: 'Pick a path to save to',
        description: 'Opens the native save dialog and returns the chosen path, which may not exist yet.',
        scope: 'global',
        hidden: true,
        input: z.object({
          title: z.string().optional(),
          filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional(),
          defaultPath: z.string().optional(),
        }),
        handler: async (input, ctx) => {
          if (ctx.caller !== 'ui' || !this.opts.pickSavePath) throw new QuiverError('INVALID_INPUT', 'The save dialog is only available from the UI');
          return { path: (await this.opts.pickSavePath(input)) ?? null };
        },
      }),
      defineCommand({
        id: 'app.info',
        title: 'App info',
        description: 'Version, platform and MCP server status.',
        scope: 'global',
        input: z.object({}),
        handler: async () => ({ version: this.opts.version, platform: process.platform, mcp: this.mcpStatus(), secretsAvailable: this.opts.secrets.available, update: this.updateState() }),
      }),
      defineCommand({
        id: 'app.update.check',
        title: 'Check for updates',
        description: 'Asks GitHub Releases for a newer Quiver and returns the updater state. Nothing is downloaded.',
        scope: 'global',
        input: z.object({}),
        handler: async () => (this.opts.updates ? this.opts.updates.check('manual') : this.updateState()),
      }),
      defineCommand({
        id: 'app.update.channel',
        title: 'Switch update channel',
        description:
          'Follows stable releases only, or also the beta builds published for Windows from every change merged to main, then checks for updates. Leaving beta never downgrades: this copy stays on its version until a newer stable release ships.',
        scope: 'global',
        mutating: true,
        input: z.object({ channel: z.enum(['stable', 'beta']) }),
        handler: async ({ channel }) => {
          await this.config.update({ updates: { ...this.config.get().updates, channel } });
          const state = this.updateState();
          return this.opts.updates && state.supported ? this.opts.updates.check('manual') : state;
        },
      }),
      defineCommand({
        id: 'app.update.download',
        title: 'Download update',
        description: 'Downloads the available update in the background. It is installed on the next restart.',
        scope: 'global',
        mutating: true,
        input: z.object({}),
        handler: async () => {
          if (!this.opts.updates) throw new QuiverError('INVALID_INPUT', 'Updates are not available in this build.');
          return this.opts.updates.download();
        },
      }),
      defineCommand({
        id: 'app.update.install',
        title: 'Restart and install update',
        description: 'Quits Quiver, installs the downloaded update and starts it again.',
        scope: 'global',
        mutating: true,
        input: z.object({}),
        handler: async () => {
          if (!this.opts.updates) throw new QuiverError('INVALID_INPUT', 'Updates are not available in this build.');
          await this.opts.updates.install();
          return { restarting: true };
        },
      }),
      defineCommand({
        id: 'mcp.restart',
        title: 'Restart MCP server',
        description: 'Restarts the built-in MCP server.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => {
          if (this.config.get().mcp.enabled) await this.startMcp();
          return this.mcpStatus();
        },
      }),
      // Agent permissions, approvals and activity are the user's controls over agents, so none of them is a tool.
      defineCommand({
        id: 'mcp.activity.list',
        title: 'Agent activity',
        description: 'The last 200 calls agents made to the MCP server, newest first, without arguments, plus the calls waiting for approval.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => ({ calls: this.activity.values().reverse(), pending: this.approvals.list(), grants: this.approvals.grants(), paused: this.config.get().mcp.paused }),
      }),
      defineCommand({
        id: 'mcp.approval.list',
        title: 'Agent calls waiting for approval',
        description: 'The calls agents made that wait for the user to allow or deny them, oldest first. Arguments are masked.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.approvals.list(),
      }),
      defineCommand({
        id: 'mcp.approval.respond',
        title: 'Answer an agent call waiting for approval',
        description:
          'Allows the call once, allows the tool for this agent until Quiver restarts (session), allows the tool for good by adding an allow rule (always: in the workspace rules when one of them matches the tool, otherwise the global ones), or denies the call. Only the UI answers.',
        scope: 'global',
        hidden: true,
        input: z.object({ id: z.string(), choice: z.enum(['once', 'session', 'always', 'deny']) }),
        handler: async ({ id, choice }, ctx) => {
          if (ctx.caller !== 'ui') throw new QuiverError('INVALID_INPUT', 'Only the Quiver window answers approvals');
          const pending = this.approvals.list().find((p) => p.id === id);
          if (!pending) throw new QuiverError('NOT_FOUND', `No approval ${id} is waiting; it may have been answered or timed out`);
          // Answer first, so the call cannot time out while the rule is written. The new rule lets through only the
          // other waiting calls it would let through later: a workspace rule only those in that workspace, and a global
          // one not those a workspace rule still asks about.
          const level = choice === 'always' ? this.allowLevel(pending) : undefined;
          const next = level ? this.withAllowRule(pending, level) : undefined;
          const answered = this.approvals.respond(id, choice, next ? { covers: (other) => this.allowedBy(next, other) } : {});
          if (next) await this.config.update({ mcp: next });
          return { answered, choice, level };
        },
      }),
      defineCommand({
        id: 'mcp.approval.clearGrants',
        title: 'Forget tools allowed until restart',
        description: 'Takes back every "allow this tool for this agent until Quiver restarts", so those calls ask again.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => {
          this.approvals.clearGrants();
          this.emit('mcp.activity', { reason: 'approvals', pending: this.approvals.list().length });
          return { grants: [] };
        },
      }),
      defineCommand({
        id: 'mcp.pause',
        title: 'Pause or resume agents',
        description: 'While paused, every MCP call is refused and calls waiting for approval are denied; the tool list stays.',
        scope: 'global',
        hidden: true,
        input: z.object({ paused: z.boolean() }),
        handler: async ({ paused }, ctx) => {
          if (ctx.caller === 'mcp') throw new QuiverError('INVALID_INPUT', 'Agents cannot pause or resume themselves');
          return this.setPaused(paused);
        },
      }),
      defineCommand({
        id: 'mcp.permissions.setMode',
        title: 'Set what mutating agent calls get',
        description: 'Refuse (read-only), ask the user, or allow the mutating calls no rule matches.',
        scope: 'global',
        hidden: true,
        input: z.object({ mode: z.enum(['read-only', 'ask', 'allow']) }),
        handler: async ({ mode }, ctx) => {
          if (ctx.caller === 'mcp') throw new QuiverError('INVALID_INPUT', 'Agents cannot change their own permissions');
          const mcp = this.config.get().mcp;
          return (await this.config.update({ mcp: { ...mcp, permissions: { ...mcp.permissions, mode } } })).mcp.permissions;
        },
      }),
      defineCommand({
        id: 'mcp.permissions.setRule',
        title: 'Set or remove an agent rule',
        description: 'Adds or changes the global or workspace rule for a command id or glob; a null action removes it.',
        scope: 'global',
        hidden: true,
        input: ruleSchema.extend({ level: z.enum(['global', 'workspace']), action: ruleSchema.shape.action.nullable() }),
        handler: async ({ level, match, action }, ctx) => {
          if (ctx.caller === 'mcp') throw new QuiverError('INVALID_INPUT', 'Agents cannot change their own permissions');
          const apply = (rules: AgentPermissionRule[]) => (action ? upsertRule(rules, { match, action }) : rules.filter((r) => r.match !== match));
          if (level === 'global') {
            const mcp = this.config.get().mcp;
            return { rules: (await this.config.update({ mcp: { ...mcp, permissions: { ...mcp.permissions, rules: apply(mcp.permissions.rules) } } })).mcp.permissions.rules };
          }
          if (!ctx.workspace) throw new QuiverError('NO_WORKSPACE', 'Workspace rules need an open workspace');
          return this.writeWorkspaceRules(ctx.workspace.id, apply(workspaceRulesFor(this.config.get().mcp, ctx.workspace.id)));
        },
      }),
      defineCommand({
        id: 'mcp.permissions.workspace',
        title: 'Workspace agent rules',
        description: 'The rules for agents of this workspace, kept on this machine in the global config, never in the project. They come before the global rules.',
        scope: 'workspace',
        hidden: true,
        input: z.object({}),
        handler: async (_input, ctx) => ({ rules: workspaceRulesFor(this.config.get().mcp, ctx.workspace!.id) }),
      }),
      defineCommand({
        id: 'mcp.permissions.setWorkspace',
        title: 'Save workspace agent rules',
        description: 'Replaces the rules for agents of this workspace.',
        scope: 'workspace',
        hidden: true,
        input: z.object({ rules: z.array(ruleSchema) }),
        handler: async ({ rules }, ctx) => {
          if (ctx.caller === 'mcp') throw new QuiverError('INVALID_INPUT', 'Agents cannot change their own permissions');
          return this.writeWorkspaceRules(ctx.workspace!.id, rules);
        },
      }),
      // The recording is the user's view of what agents do, so none of it is a tool agents can call.
      defineCommand({
        id: 'mcp.recording.status',
        title: 'MCP call recording status',
        description: 'Whether the calls agents make to the MCP server are being recorded, and how many were.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.recorder.status(),
      }),
      defineCommand({
        id: 'mcp.recording.start',
        title: 'Start recording MCP calls',
        description: 'Starts a new recording of the calls agents make to the MCP server, in memory. A previous recording is dropped.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.recorder.start(),
      }),
      defineCommand({
        id: 'mcp.recording.pause',
        title: 'Pause recording MCP calls',
        description: 'Stops keeping calls until the recording is resumed.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.recorder.pause(),
      }),
      defineCommand({
        id: 'mcp.recording.resume',
        title: 'Resume recording MCP calls',
        description: 'Continues a paused recording.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.recorder.resume(),
      }),
      defineCommand({
        id: 'mcp.recording.end',
        title: 'End recording MCP calls',
        description: 'Ends the recording. It stays in memory to be looked at and saved.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.recorder.end(),
      }),
      defineCommand({
        id: 'mcp.recording.clear',
        title: 'Discard the MCP call recording',
        description: 'Drops the recording from memory.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => this.recorder.clear(),
      }),
      defineCommand({
        id: 'mcp.recording.list',
        title: 'List recorded MCP calls',
        description: 'The recorded calls without their arguments and results, oldest first.',
        scope: 'global',
        hidden: true,
        input: z.object({}),
        handler: async () => ({ status: this.recorder.status(), calls: this.recorder.list() }),
      }),
      defineCommand({
        id: 'mcp.recording.get',
        title: 'Read a recorded MCP call',
        description: 'One recorded call with its arguments and its result.',
        scope: 'global',
        hidden: true,
        input: z.object({ id: z.string() }),
        handler: async ({ id }) => {
          const call = this.recorder.get(id);
          if (!call) throw new QuiverError('NOT_FOUND', `No recorded call ${id}`);
          return call;
        },
      }),
      defineCommand({
        id: 'mcp.recording.save',
        title: 'Save the MCP call recording',
        description: 'Writes the ended recording to a JSON file. Without a path the UI asks where to save it; returns null when that is cancelled.',
        scope: 'global',
        hidden: true,
        input: z.object({ path: z.string().optional() }),
        handler: async ({ path: file }, ctx) => {
          if (ctx.caller !== 'ui') throw new QuiverError('INVALID_INPUT', 'Saving a recording is only available from the UI');
          const status = this.recorder.status();
          if (status.state !== 'ended') throw new QuiverError('INVALID_INPUT', 'End the recording before saving it');
          let target = file;
          if (!target) {
            if (!this.opts.pickSavePath) throw new QuiverError('INVALID_INPUT', 'A file path is required');
            target = await this.opts.pickSavePath({ title: 'Save MCP call recording', defaultPath: mcpRecordingFileName(status.startedAt), filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (!target) return null;
          }
          const recording = this.recorder.export(this.opts.version);
          await fs.writeFile(target, `${JSON.stringify(recording, null, 2)}\n`);
          this.recorder.markSaved(target);
          return { path: target, calls: recording.calls.length };
        },
      }),
    ];
  }
}
