import path from 'node:path';
import {
  CommandRegistry,
  QuiverError,
  defineCommand,
  toErrorPayload,
  type Caller,
  type ErrorPayload,
  type GlobalConfig,
  type HostApi,
  type HostEventName,
  type HostEvents,
  type RecentWorkspace,
  type SecretsApi,
  type WorkspaceApi,
} from '@quiver/core';
import { GlobalStore, WorkspaceManager, workspaceIdFor, type WorkspaceSession } from '@quiver/core/node';
import { startMcpServer, type RunningMcpServer } from '@quiver/mcp';
import { mainModules } from '@quiver/modules/main';
import { z } from 'zod';

export interface HostOptions {
  userDataDir: string;
  version: string;
  secrets: SecretsApi;
  broadcast(message: { event: HostEventName; payload: unknown }): void;
  pickFolder?(): Promise<string | undefined>;
  pickFile?(options?: { title?: string; filters?: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<string | undefined>;
}

export interface InvokeOptions {
  caller: Caller;
  workspaceId?: string | null;
}

export type InvokeOutcome = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

export class Host {
  readonly registry = new CommandRegistry();
  readonly config: GlobalStore;
  readonly workspaces: WorkspaceManager;
  readonly api: HostApi;
  private mcp: RunningMcpServer | null = null;
  private activeWorkspaceId: string | null = null;

  constructor(private readonly opts: HostOptions) {
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
      emit: (event, payload) => this.emit(event, payload),
      dialogs: opts.pickFile ? { pickFile: opts.pickFile } : undefined,
    };

    this.registry.registerModule({ id: 'host', commands: this.hostCommands() });
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
      const result = await this.registry.execute(id, input, { caller: options.caller, host: this.api, workspace });
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
    await this.stopMcp();
    const { port } = this.config.get().mcp;
    try {
      this.mcp = await startMcpServer({
        registry: this.registry,
        host: this.api,
        port,
        version: this.opts.version,
        resolveWorkspace: (hint) => this.resolveWorkspace(hint),
        onCall: (entry) => this.emit('mcp.call', entry),
      });
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
    this.emit('mcp.status', { running: false, port: this.config.get().mcp.port });
  }

  mcpStatus(): HostEvents['mcp.status'] {
    return { running: this.mcp !== null, port: this.config.get().mcp.port };
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
        id: 'app.info',
        title: 'App info',
        description: 'Version, platform and MCP server status.',
        scope: 'global',
        input: z.object({}),
        handler: async () => ({ version: this.opts.version, platform: process.platform, mcp: this.mcpStatus(), secretsAvailable: this.opts.secrets.available }),
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
    ];
  }
}
