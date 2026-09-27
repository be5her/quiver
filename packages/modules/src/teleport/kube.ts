import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QuiverError,
  addKubeHistory,
  buildKubectlArgs,
  formatCommandLine,
  isLoginRequiredMessage,
  kubeOperationInfo,
  kubeconfigCurrentContext,
  newId,
  normalizeProxy,
  nowIso,
  sanitizeKubeHistory,
  type Caller,
  type KubeHistoryEntry,
  type KubePreview,
  type KubeQuery,
  type KubeRunResult,
  type KubeStreamRead,
} from '@quiver/core';
import type { TeleportSession } from './session';
import { killTree, lineSplitter, spawnTsh, type TshCommand } from './tsh';

const STDOUT_CAP = 2 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;
const STREAM_LINES = 5000;
const MAX_LIVE_STREAMS = 8;
const FINISHED_STREAMS_KEPT = 8;
/** A followed log stops on its own after this long, so a forgotten stream does not run forever. */
const STREAM_MAX_MS = 60 * 60_000;
const LOGIN_TIMEOUT_MS = 60_000;
/** How long a stopped run may take to close its output before Quiver closes it and ends the run anyway. */
const STOP_GRACE_MS = 3000;

export interface KubeRunnerOptions {
  session: TeleportSession;
  /** Folder for the private kubeconfigs and the history file; null keeps history in memory. */
  dataDir: string | null;
  onHistory(): void;
  onStream(runId: string): void;
}

export interface KubeRunRequest {
  proxy: string;
  cluster: string;
  query: KubeQuery;
  caller: Caller;
  runId?: string;
  timeoutMs: number;
  /** False for picker lookups, which stay out of the history. */
  record: boolean;
}

interface LiveRun {
  runId: string;
  child: ChildProcess;
  streaming: boolean;
  startedAt: number;
  lines: string[];
  /** Sequence number of lines[0]. */
  first: number;
  dropped: number;
  stderr: string;
  exitCode: number | null;
  running: boolean;
  cancelled: boolean;
  historyId: string;
  endedAt: number | null;
  /** Mark the run finished (idempotent); the process's exit code, or null when it never reported one. */
  end(code: number | null): void;
}

interface Prepared {
  kubeconfig: string;
  context: string;
}

const WINDOWS = process.platform === 'win32';

/**
 * Runs catalogue queries with `tsh kubectl`, which embeds kubectl, so no kubectl install is needed.
 *
 * Each (cluster, Kubernetes cluster) pair gets a private kubeconfig under the app data folder,
 * written once by `tsh kube login` with KUBECONFIG pointing at it. Every query then runs
 * `tsh kubectl <template args> --kubeconfig=<that file> --context=<its context>` with no extra
 * environment, so what the preview shows is exactly what is spawned, and the kubeconfig your
 * terminal uses is never read or changed. The flags go after the subcommand because tsh parses
 * its own flags up to the first positional argument and rejects kubectl's.
 */
export class KubeRunner {
  private readonly contexts = new Map<string, Promise<Prepared>>();
  /** Contexts that finished preparing, for previews that must not spawn anything. */
  private readonly ready = new Map<string, Prepared>();
  private readonly runs = new Map<string, LiveRun>();
  private history: KubeHistoryEntry[] | null = null;
  private historyMtime = 0;
  private writing: Promise<void> = Promise.resolve();
  private readonly lastStreamEmit = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timedOut = new Set<string>();

  constructor(private readonly opts: KubeRunnerOptions) {}

  private get dir(): string | null {
    return this.opts.dataDir ? path.join(this.opts.dataDir, 'teleport-kube') : null;
  }

  // ---------- private kubeconfig ----------

  private key(proxy: string, cluster: string): string {
    return `${normalizeProxy(proxy)}\n${cluster}`;
  }

  private kubeconfigPath(proxy: string, cluster: string): string {
    const dir = this.dir ?? path.join(os.tmpdir(), 'quiver-teleport-kube');
    const hash = createHash('sha256').update(this.key(proxy, cluster)).digest('hex').slice(0, 20);
    return path.join(dir, `${hash}.kubeconfig`);
  }

  /** tsh's default context name, `<teleport cluster>-<kube cluster>`, until the kubeconfig says otherwise. */
  private defaultContext(proxy: string, cluster: string): string {
    return `${this.opts.session.cluster(proxy)?.cluster ?? normalizeProxy(proxy).replace(/:\d+$/, '')}-${cluster}`;
  }

  /** The one-time preparation, as the exact argv and environment it runs with. */
  private setupCommand(tsh: TshCommand, proxy: string, cluster: string): { argv: string[]; env: Record<string, string> } {
    return { argv: [...tsh.argv, 'kube', 'login', cluster, `--proxy=${proxy}`], env: { KUBECONFIG: this.kubeconfigPath(proxy, cluster) } };
  }

  /**
   * `tsh kube login` into the private kubeconfig once per app run; the kube credentials plugin
   * renews certificates after that. `created` tells the caller that this call did the login.
   */
  private async ensureContext(proxy: string, cluster: string, fresh = false): Promise<{ prepared: Prepared; created: boolean }> {
    const key = this.key(proxy, cluster);
    const cached = this.contexts.get(key);
    if (cached && !fresh) return { prepared: await cached, created: false };
    this.ready.delete(key);
    const pending = (async () => {
      const kubeconfig = this.kubeconfigPath(proxy, cluster);
      await fs.mkdir(path.dirname(kubeconfig), { recursive: true });
      // session.run appends --proxy, matching setupCommand().
      await this.opts.session.run(['kube', 'login', cluster], proxy, LOGIN_TIMEOUT_MS, { KUBECONFIG: kubeconfig });
      const text = await fs.readFile(kubeconfig, 'utf8').catch(() => '');
      const prepared = { kubeconfig, context: kubeconfigCurrentContext(text) ?? this.defaultContext(proxy, cluster) };
      this.ready.set(key, prepared);
      return prepared;
    })();
    pending.catch(() => this.contexts.delete(key));
    this.contexts.set(key, pending);
    return { prepared: await pending, created: true };
  }

  /** Forget contexts, e.g. after a logout; the next query logs in again. */
  forget(proxy?: string): void {
    for (const map of [this.contexts, this.ready]) {
      if (!proxy) map.clear();
      else for (const key of [...map.keys()]) if (key.startsWith(`${normalizeProxy(proxy)}\n`)) map.delete(key);
    }
  }

  /** The full argv for one query: tsh, `kubectl`, the template, then the explicit kubeconfig and context. */
  private queryArgv(tsh: TshCommand, args: string[], prepared: Prepared): string[] {
    return [...tsh.argv, 'kubectl', ...args, `--kubeconfig=${prepared.kubeconfig}`, `--context=${prepared.context}`];
  }

  /** What a query would spawn, without spawning anything. */
  async preview(proxy: string, cluster: string, query: KubeQuery): Promise<KubePreview> {
    const args = buildKubectlArgs(query.operation, query.params);
    const tsh = await this.opts.session.tshCommand();
    const resolved = this.opts.session.cluster(proxy)?.proxy ?? proxy;
    const prepared = this.ready.get(this.key(resolved, cluster));
    const argv = this.queryArgv(tsh, args, prepared ?? { kubeconfig: this.kubeconfigPath(resolved, cluster), context: this.defaultContext(resolved, cluster) });
    const setup = prepared ? null : this.setupCommand(tsh, resolved, cluster);
    return { command: formatCommandLine(argv, { windows: WINDOWS }), argv, contextConfirmed: Boolean(prepared), setup: setup ? formatCommandLine(setup.argv, { windows: WINDOWS, env: setup.env }) : null };
  }

  // ---------- running ----------

  async run(req: KubeRunRequest): Promise<KubeRunResult> {
    const info = kubeOperationInfo(req.query.operation);
    // Validates again: the catalogue is the only way to an argv, whoever the caller is.
    const args = buildKubectlArgs(req.query.operation, req.query.params);
    const runId = req.runId ?? newId();
    if (this.runs.get(runId)?.running) throw new QuiverError('INVALID_INPUT', `Run ${runId} is already running`);
    const cluster = await this.opts.session.requireSession(req.proxy);
    const tsh = await this.opts.session.tshCommand();
    let setup: string | null = null;

    const attempt = async (fresh: boolean) => {
      const { prepared, created } = await this.ensureContext(cluster.proxy, req.cluster, fresh);
      if (created) {
        const cmd = this.setupCommand(tsh, cluster.proxy, req.cluster);
        setup = formatCommandLine(cmd.argv, { windows: WINDOWS, env: cmd.env });
      }
      const argv = this.queryArgv(tsh, args, prepared);
      return { argv, live: await this.spawnRun(runId, tsh, argv, Boolean(info?.streaming), req.timeoutMs) };
    };

    const startedAt = nowIso();
    let { argv, live } = await attempt(false);
    // The private kubeconfig vanished or lost its context (data folder cleaned, tsh upgraded): log in again once.
    if (!live.running && live.exitCode !== 0 && /context .*(does not exist|not found)|no configuration has been provided|kubeconfig/i.test(live.stderr)) {
      this.runs.delete(runId);
      ({ argv, live } = await attempt(true));
    }
    if (!live.running && live.exitCode !== 0 && isLoginRequiredMessage(live.stderr)) {
      this.forget(cluster.proxy);
      void this.opts.session.refresh().catch(() => {});
      throw new QuiverError('TELEPORT_LOGIN_REQUIRED', `Teleport session for ${cluster.proxy} is not usable: ${live.stderr.trim().split(/\r?\n/).pop()}`, { proxy: cluster.proxy });
    }

    const entry: KubeHistoryEntry = {
      id: live.historyId,
      proxy: cluster.proxy,
      cluster: req.cluster,
      query: req.query,
      at: startedAt,
      exitCode: live.exitCode,
      durationMs: (live.endedAt ?? Date.now()) - live.startedAt,
      pinned: false,
      caller: req.caller,
    };
    if (req.record) await this.record(entry);

    const result: KubeRunResult = {
      runId,
      proxy: cluster.proxy,
      cluster: req.cluster,
      query: req.query,
      command: formatCommandLine(argv, { windows: WINDOWS }),
      argv,
      setup,
      stdout: live.lines.join('\n'),
      stderr: live.stderr,
      exitCode: live.exitCode,
      durationMs: entry.durationMs,
      truncated: live.dropped > 0,
      cancelled: live.cancelled,
      timedOut: this.timedOut.has(runId),
      streaming: live.running,
      historyId: live.historyId,
      startedAt,
    };
    this.timedOut.delete(runId);
    if (!live.streaming) this.runs.delete(runId);
    return result;
  }

  /**
   * Spawn the argv with no shell and no extra environment. A one-shot query resolves when the
   * process exits (or is cancelled or times out); a stream resolves after its first output,
   * a quick exit, or a second, and keeps running.
   */
  private spawnRun(runId: string, tsh: TshCommand, argv: string[], streaming: boolean, timeoutMs: number): Promise<LiveRun> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnTsh(tsh, argv.slice(tsh.argv.length), { tree: true });
      } catch (err) {
        reject(new QuiverError('REQUEST_FAILED', `Could not start tsh kubectl: ${(err as Error).message}`));
        return;
      }
      if (streaming) this.pruneStreams();
      let bytes = 0;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        resolve(live);
      };
      const live: LiveRun = {
        runId,
        child,
        streaming,
        startedAt: Date.now(),
        lines: [],
        first: 0,
        dropped: 0,
        stderr: '',
        exitCode: null,
        running: true,
        cancelled: false,
        historyId: newId(),
        endedAt: null,
        end: (code) => {
          if (!live.running) return;
          outLines('\n');
          if (live.lines.length && live.lines[live.lines.length - 1] === '') live.lines.pop();
          live.running = false;
          live.exitCode = live.cancelled || this.timedOut.has(runId) ? null : code;
          live.endedAt = Date.now();
          clearTimeout(killTimer);
          if (streaming && settled) void this.finishStream(live);
          settle();
        },
      };
      this.runs.set(runId, live);
      const push = (line: string) => {
        if (!live.running) return;
        if (!streaming) {
          if (bytes > STDOUT_CAP) {
            live.dropped++;
            return;
          }
          bytes += line.length + 1;
        }
        live.lines.push(line);
        if (live.lines.length > STREAM_LINES && streaming) {
          const extra = live.lines.length - STREAM_LINES;
          live.lines.splice(0, extra);
          live.first += extra;
          live.dropped += extra;
        }
        if (streaming) {
          this.emitStream(runId);
          settle();
        }
      };
      const outLines = lineSplitter(push);
      child.stdout?.on('data', outLines);
      child.stderr?.on('data', (chunk: Buffer) => {
        if (live.running && live.stderr.length < STDERR_CAP) live.stderr += chunk.toString().slice(0, STDERR_CAP - live.stderr.length);
      });
      const limit = streaming ? STREAM_MAX_MS : timeoutMs;
      const killTimer = setTimeout(() => {
        if (!live.running) return;
        this.timedOut.add(runId);
        this.stop(live);
      }, limit);
      killTimer.unref?.();
      const startTimer = setTimeout(settle, streaming ? 1000 : 2 ** 31 - 1);
      child.on('error', (err) => {
        live.running = false;
        live.endedAt = Date.now();
        clearTimeout(killTimer);
        if (!settled) {
          settled = true;
          clearTimeout(startTimer);
          this.runs.delete(runId);
          reject(new QuiverError('REQUEST_FAILED', `Could not start tsh kubectl (${tsh.argv[0]}): ${err.message}`));
        }
      });
      child.on('exit', () => {
        // 'close' follows once the pipes close. A process tsh started that outlived it would keep
        // them open (and keep streaming), so close them after a grace period.
        const grace = setTimeout(() => {
          if (!live.running) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, STOP_GRACE_MS);
        grace.unref?.();
      });
      child.on('close', (code) => live.end(code));
    });
  }

  /**
   * Stop a run and every process tsh started for it. If it has not ended a few seconds later,
   * it is killed harder and ended here, so a stopped run always ends.
   */
  private stop(live: LiveRun): void {
    if (!live.running) return;
    killTree(live.child);
    const force = setTimeout(() => {
      if (!live.running) return;
      killTree(live.child, 'SIGKILL');
      live.child.stdout?.destroy();
      live.child.stderr?.destroy();
      live.end(null);
    }, STOP_GRACE_MS);
    force.unref?.();
  }

  private emitStream(runId: string): void {
    if (this.lastStreamEmit.has(runId)) return;
    this.lastStreamEmit.set(
      runId,
      setTimeout(() => {
        this.lastStreamEmit.delete(runId);
        this.opts.onStream(runId);
      }, 200),
    );
  }

  private async finishStream(live: LiveRun): Promise<void> {
    this.emitStream(live.runId);
    const entries = await this.loadHistory();
    const entry = entries.find((e) => e.id === live.historyId);
    if (entry) await this.saveHistory(entries.map((e) => (e.id === live.historyId ? { ...e, exitCode: live.exitCode, durationMs: (live.endedAt ?? Date.now()) - live.startedAt } : e)));
  }

  /** Stop the oldest streams beyond the cap and forget finished ones nobody read. */
  private pruneStreams(): void {
    const streams = [...this.runs.values()].filter((r) => r.streaming);
    const live = streams.filter((r) => r.running).sort((a, b) => a.startedAt - b.startedAt);
    while (live.length >= MAX_LIVE_STREAMS) this.cancel(live.shift()!.runId);
    const finished = streams.filter((r) => !r.running).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (finished.length > FINISHED_STREAMS_KEPT) this.runs.delete(finished.shift()!.runId);
  }

  read(runId: string, since = 0): KubeStreamRead {
    const live = this.runs.get(runId);
    if (!live || !live.streaming) throw new QuiverError('NOT_FOUND', `No log stream ${runId}. Start one with the logs-follow operation.`);
    const from = Math.max(since, live.first);
    return {
      runId,
      lines: live.lines.slice(from - live.first),
      next: live.first + live.lines.length,
      dropped: since < live.first ? live.first - since : 0,
      running: live.running,
      exitCode: live.exitCode,
      stderr: live.stderr,
      durationMs: (live.endedAt ?? Date.now()) - live.startedAt,
    };
  }

  cancel(runId: string): boolean {
    const live = this.runs.get(runId);
    if (!live?.running) return false;
    live.cancelled = true;
    this.stop(live);
    return true;
  }

  stopAll(): void {
    for (const live of this.runs.values()) {
      if (!live.running) continue;
      live.cancelled = true;
      this.stop(live);
    }
    for (const timer of this.lastStreamEmit.values()) clearTimeout(timer);
    this.lastStreamEmit.clear();
  }

  // ---------- history ----------

  private historyFile(): string | null {
    return this.dir ? path.join(this.dir, 'history.json') : null;
  }

  /**
   * Entries from disk, each validated like a live query; tampered ones are left out. The file is
   * reread when it changed since Quiver last wrote it, so an edit outside Quiver is noticed.
   */
  async loadHistory(): Promise<KubeHistoryEntry[]> {
    await this.writing.catch(() => {});
    const file = this.historyFile();
    if (!file) return (this.history ??= []);
    const mtime = await fs.stat(file).then((st) => st.mtimeMs, () => 0);
    if (this.history && mtime === this.historyMtime) return this.history;
    let raw: unknown = [];
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      raw = [];
    }
    const { entries, dropped } = sanitizeKubeHistory(raw);
    if (dropped) console.warn(`[quiver] ignored ${dropped} invalid Kubernetes history entr${dropped === 1 ? 'y' : 'ies'} in ${file}`);
    this.history = entries;
    this.historyMtime = mtime;
    return entries;
  }

  /** Replace the history. Writes are serialized; the file is swapped in atomically. */
  async saveHistory(entries: KubeHistoryEntry[]): Promise<void> {
    this.history = entries;
    const file = this.historyFile();
    if (file) {
      const snapshot = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
      this.writing = this.writing
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(`${file}.tmp`, snapshot, 'utf8');
          await fs.rename(`${file}.tmp`, file);
          this.historyMtime = (await fs.stat(file)).mtimeMs;
        });
      await this.writing;
    }
    this.opts.onHistory();
  }

  private async record(entry: KubeHistoryEntry): Promise<void> {
    await this.saveHistory(addKubeHistory(await this.loadHistory(), entry));
  }
}
