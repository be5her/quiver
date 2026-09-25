import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { QuiverError, isLoginRequiredMessage, newId, nowIso, tokenizeShell, type TeleportTunnel } from '@quiver/core';
import { lineSplitter, type TshCommand } from './tsh';

export type TunnelSpec = { kind: 'teleport'; database: string; dbUser: string } | { kind: 'command'; command: string };

interface LiveTunnel {
  key: string;
  info: Omit<TeleportTunnel, 'users' | 'output'>;
  users: Set<string>;
  output: string[];
  child: ChildProcess;
  exited: boolean;
  /** Resolves once the port accepts TCP, rejects when the process dies first. */
  ready: Promise<void>;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

export interface TunnelManagerOptions {
  /** Resolved tsh, or throws NOT_FOUND. */
  tsh(): Promise<TshCommand>;
  /** Throws TELEPORT_LOGIN_REQUIRED when the session cannot back a tunnel. */
  requireSession(): Promise<void>;
  onChange(): void;
  /** How long a tunnel outlives its last user before it is stopped. */
  graceMs?: number;
  readyTimeoutMs?: number;
}

const OUTPUT_TAIL = 60;

export function tunnelKey(spec: TunnelSpec): string {
  return spec.kind === 'teleport' ? `teleport:${spec.database}:${spec.dbUser}` : `command:${spec.command.trim()}`;
}

/**
 * App-wide local tunnels: `tsh proxy db --tunnel` per Teleport database and user, or any
 * command with a `{port}` placeholder. Shared by every workspace; a tunnel stays up while
 * something uses it and for a short grace period after, so reconnects are cheap.
 */
export class TunnelManager {
  private readonly tunnels = new Map<string, LiveTunnel>();
  private readonly starting = new Map<string, Promise<LiveTunnel>>();

  constructor(private readonly opts: TunnelManagerOptions) {}

  list(): TeleportTunnel[] {
    return [...this.tunnels.values()].map(toInfo);
  }

  find(spec: TunnelSpec): TeleportTunnel | null {
    const live = this.tunnels.get(tunnelKey(spec));
    return live && !live.exited ? toInfo(live) : null;
  }

  get(id: string): TeleportTunnel | null {
    const live = [...this.tunnels.values()].find((t) => t.info.id === id);
    return live ? toInfo(live) : null;
  }

  /** Start the tunnel unless one is already running, and register `user` as holding it open. */
  async ensure(spec: TunnelSpec, user: string): Promise<TeleportTunnel> {
    const key = tunnelKey(spec);
    let live = this.tunnels.get(key);
    if (live?.exited) {
      this.tunnels.delete(key);
      live = undefined;
    }
    if (!live) {
      let pending = this.starting.get(key);
      if (!pending) {
        pending = this.start(spec, key).finally(() => this.starting.delete(key));
        this.starting.set(key, pending);
      }
      live = await pending;
    }
    await live.ready;
    live.users.add(user);
    if (live.graceTimer) {
      clearTimeout(live.graceTimer);
      live.graceTimer = null;
    }
    this.opts.onChange();
    return toInfo(live);
  }

  /** Drop a user from every tunnel; tunnels left without users stop after the grace period (or now). */
  async release(user: string, options: { immediate?: boolean } = {}): Promise<void> {
    for (const live of this.tunnels.values()) {
      if (!live.users.delete(user)) continue;
      if (live.users.size > 0) continue;
      if (options.immediate || !this.opts.graceMs) {
        await this.kill(live);
      } else if (!live.graceTimer) {
        live.graceTimer = setTimeout(() => {
          live.graceTimer = null;
          if (live.users.size === 0) void this.kill(live);
        }, this.opts.graceMs);
        live.graceTimer.unref?.();
      }
    }
    this.opts.onChange();
  }

  async stop(id: string): Promise<boolean> {
    const live = [...this.tunnels.values()].find((t) => t.info.id === id);
    if (!live) return false;
    await this.kill(live);
    return true;
  }

  /** Stop every tunnel for a Teleport database (optionally only for one db user). */
  async stopTeleport(database: string, dbUser?: string): Promise<number> {
    let n = 0;
    for (const live of [...this.tunnels.values()]) {
      if (live.info.kind !== 'teleport' || live.info.target !== database) continue;
      if (dbUser && live.info.dbUser !== dbUser) continue;
      await this.kill(live);
      n++;
    }
    return n;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tunnels.values()].map((t) => this.kill(t)));
  }

  private async start(spec: TunnelSpec, key: string): Promise<LiveTunnel> {
    const port = await freePort();
    let argv: string[];
    if (spec.kind === 'teleport') {
      await this.opts.requireSession();
      const tsh = await this.opts.tsh();
      argv = [...tsh.argv, 'proxy', 'db', spec.database, '--tunnel', `--db-user=${spec.dbUser}`, `--port=${port}`];
    } else {
      argv = tokenizeShell(spec.command.replaceAll('{port}', String(port)));
      if (!argv.length) throw new QuiverError('INVALID_INPUT', 'Tunnel command is empty');
      if (!spec.command.includes('{port}')) throw new QuiverError('INVALID_INPUT', 'Tunnel command needs a {port} placeholder for the local port');
    }

    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    } catch (err) {
      throw new QuiverError('REQUEST_FAILED', `Could not start tunnel: ${(err as Error).message}`);
    }

    const live: LiveTunnel = {
      key,
      info: {
        id: newId(),
        kind: spec.kind,
        target: spec.kind === 'teleport' ? spec.database : spec.command,
        dbUser: spec.kind === 'teleport' ? spec.dbUser : null,
        port,
        pid: child.pid ?? null,
        startedAt: nowIso(),
      },
      users: new Set(),
      output: [],
      child,
      exited: false,
      ready: Promise.resolve(),
      graceTimer: null,
    };
    const push = (line: string) => {
      if (!line.trim()) return;
      live.output.push(line);
      if (live.output.length > OUTPUT_TAIL) live.output.splice(0, live.output.length - OUTPUT_TAIL);
    };
    child.stdout?.on('data', lineSplitter(push));
    child.stderr?.on('data', lineSplitter(push));

    let exitError: QuiverError | null = null;
    const exited = new Promise<never>((_, reject) => {
      child.on('error', (err) => {
        exitError = new QuiverError('REQUEST_FAILED', `Could not start ${argv[0]}: ${err.message}`);
        reject(exitError);
      });
      child.on('close', (code) => {
        const text = live.output.join('\n');
        const detail = live.output.findLast((l) => /error/i.test(l)) ?? live.output[live.output.length - 1] ?? `exited with code ${code ?? 'null'}`;
        const message = detail.replace(/^ERROR:\s*/i, '');
        exitError = isLoginRequiredMessage(text)
          ? new QuiverError('TELEPORT_LOGIN_REQUIRED', `Teleport tunnel for ${live.info.target} could not start: ${message}`, { output: live.output })
          : new QuiverError('REQUEST_FAILED', `Tunnel for ${live.info.target} exited: ${message}`, { output: live.output, code });
        reject(exitError);
      });
    });
    exited.catch(() => {});

    live.ready = Promise.race([waitForPort(port, this.opts.readyTimeoutMs ?? 20_000), exited]).catch((err) => {
      throw exitError ?? err;
    });
    this.tunnels.set(key, live);
    this.opts.onChange();

    child.on('close', () => {
      live.exited = true;
      if (live.graceTimer) clearTimeout(live.graceTimer);
      if (this.tunnels.get(key) === live) this.tunnels.delete(key);
      this.opts.onChange();
    });

    try {
      await live.ready;
    } catch (err) {
      if (!live.exited) child.kill();
      throw err;
    }
    return live;
  }

  private kill(live: LiveTunnel): Promise<void> {
    if (live.graceTimer) clearTimeout(live.graceTimer);
    live.graceTimer = null;
    if (this.tunnels.get(live.key) === live) this.tunnels.delete(live.key);
    if (live.exited) {
      this.opts.onChange();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(force);
        resolve();
      };
      const force = setTimeout(() => {
        live.child.kill('SIGKILL');
        setTimeout(done, 200);
      }, 3000);
      live.child.once('close', done);
      live.child.kill();
    });
  }
}

function toInfo(live: LiveTunnel): TeleportTunnel {
  return { ...live.info, users: [...live.users], output: [...live.output] };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export function probePort(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new QuiverError('REQUEST_FAILED', `Tunnel did not open port ${port} within ${Math.round(timeoutMs / 1000)}s`);
}
