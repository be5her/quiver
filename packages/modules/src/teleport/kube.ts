import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  QuiverError,
  addKubeHistory,
  buildKubectlArgs,
  formatKubectlCommand,
  isLoginRequiredMessage,
  kubeOperationInfo,
  kubeconfigCurrentContext,
  newId,
  normalizeProxy,
  nowIso,
  sanitizeKubeHistory,
  type Caller,
  type KubeHistoryEntry,
  type KubeQuery,
  type KubeRunResult,
  type KubeStreamRead,
} from '@quiver/core';
import type { TeleportSession } from './session';
import { lineSplitter, spawnTsh } from './tsh';

const STDOUT_CAP = 2 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;
const STREAM_LINES = 5000;
const MAX_LIVE_STREAMS = 8;
const FINISHED_STREAMS_KEPT = 8;
/** A followed log stops on its own after this long, so a forgotten stream does not run forever. */
const STREAM_MAX_MS = 60 * 60_000;
const LOGIN_TIMEOUT_MS = 60_000;

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
}

/**
 * Runs catalogue queries with `tsh kubectl`, which embeds kubectl, so no kubectl install is needed.
 *
 * Each (cluster, Kubernetes cluster) pair gets a private kubeconfig under the app data folder,
 * written once by `tsh kube login` with KUBECONFIG pointing at it. Every query then passes that
 * file and its context explicitly, so the kubeconfig your terminal uses is never read or changed.
 */
export class KubeRunner {
  private readonly contexts = new Map<string, Promise<{ kubeconfig: string; context: string }>>();
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

  private kubeconfigPath(proxy: string, cluster: string): string {
    const dir = this.dir ?? path.join(os.tmpdir(), 'quiver-teleport-kube');
    const hash = createHash('sha256').update(`${normalizeProxy(proxy)}\n${cluster}`).digest('hex').slice(0, 20);
    return path.join(dir, `${hash}.kubeconfig`);
  }

  /** `tsh kube login` into the private kubeconfig once per app run; the kube credentials plugin renews certificates after that. */
  private ensureContext(proxy: string, cluster: string, fresh = false): Promise<{ kubeconfig: string; context: string }> {
    const key = `${normalizeProxy(proxy)}\n${cluster}`;
    const cached = this.contexts.get(key);
    if (cached && !fresh) return cached;
    const pending = (async () => {
      const kubeconfig = this.kubeconfigPath(proxy, cluster);
      await fs.mkdir(path.dirname(kubeconfig), { recursive: true });
      await this.opts.session.run(['kube', 'login', cluster], proxy, LOGIN_TIMEOUT_MS, { KUBECONFIG: kubeconfig });
      const text = await fs.readFile(kubeconfig, 'utf8').catch(() => '');
      const status = this.opts.session.cluster(proxy);
      const context = kubeconfigCurrentContext(text) ?? `${status?.cluster ?? normalizeProxy(proxy).replace(/:\d+$/, '')}-${cluster}`;
      return { kubeconfig, context };
    })();
    pending.catch(() => this.contexts.delete(key));
    this.contexts.set(key, pending);
    return pending;
  }

  /** Forget contexts, e.g. after a logout; the next query logs in again. */
  forget(proxy?: string): void {
    if (!proxy) return this.contexts.clear();
    for (const key of [...this.contexts.keys()]) if (key.startsWith(`${normalizeProxy(proxy)}\n`)) this.contexts.delete(key);
  }

  // ---------- running ----------

  async run(req: KubeRunRequest): Promise<KubeRunResult> {
    const info = kubeOperationInfo(req.query.operation);
    // Validates again: the catalogue is the only way to an argv, whoever the caller is.
    const args = buildKubectlArgs(req.query.operation, req.query.params);
    const runId = req.runId ?? newId();
    if (this.runs.get(runId)?.running) throw new QuiverError('INVALID_INPUT', `Run ${runId} is already running`);
    const cluster = await this.opts.session.requireSession(req.proxy);
    const command = formatKubectlCommand(args);

    const attempt = async (fresh: boolean) => {
      const { kubeconfig, context } = await this.ensureContext(cluster.proxy, req.cluster, fresh);
      return this.spawnRun(runId, [`--kubeconfig=${kubeconfig}`, `--context=${context}`, ...args], { KUBECONFIG: kubeconfig, TELEPORT_PROXY: cluster.proxy }, Boolean(info?.streaming), req.timeoutMs);
    };

    const startedAt = nowIso();
    let live = await attempt(false);
    // The private kubeconfig vanished or lost its context (data folder cleaned, tsh upgraded): log in again once.
    if (!live.running && live.exitCode !== 0 && /context .*(does not exist|not found)|no configuration has been provided|kubeconfig/i.test(live.stderr)) {
      this.runs.delete(runId);
      live = await attempt(true);
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

    const stdout = live.lines.join('\n');
    const result: KubeRunResult = {
      runId,
      proxy: cluster.proxy,
      cluster: req.cluster,
      query: req.query,
      command,
      stdout,
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
   * Spawn `tsh kubectl` with an argv array and no shell. A one-shot query resolves when the
   * process exits (or is cancelled or times out); a stream resolves after its first output,
   * a quick exit, or a second, and keeps running.
   */
  private spawnRun(runId: string, kubectlArgs: string[], env: Record<string, string>, streaming: boolean, timeoutMs: number): Promise<LiveRun> {
    return new Promise((resolve, reject) => {
      const tshPromise = this.opts.session.tshCommand();
      void tshPromise.then((tsh) => {
        let child: ChildProcess;
        try {
          child = spawnTsh(tsh, ['kubectl', ...kubectlArgs], env);
        } catch (err) {
          reject(new QuiverError('REQUEST_FAILED', `Could not start tsh kubectl: ${(err as Error).message}`));
          return;
        }
        if (streaming) this.pruneStreams();
        const live: LiveRun = { runId, child, streaming, startedAt: Date.now(), lines: [], first: 0, dropped: 0, stderr: '', exitCode: null, running: true, cancelled: false, historyId: newId(), endedAt: null };
        this.runs.set(runId, live);
        let bytes = 0;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(startTimer);
          resolve(live);
        };
        const push = (line: string) => {
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
          if (live.stderr.length < STDERR_CAP) live.stderr += chunk.toString().slice(0, STDERR_CAP - live.stderr.length);
        });
        const limit = streaming ? STREAM_MAX_MS : timeoutMs;
        const killTimer = setTimeout(() => {
          if (!live.running) return;
          this.timedOut.add(runId);
          child.kill();
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
        child.on('close', (code) => {
          outLines('\n');
          if (live.lines.length && live.lines[live.lines.length - 1] === '') live.lines.pop();
          live.running = false;
          live.exitCode = live.cancelled || this.timedOut.has(runId) ? null : code;
          live.endedAt = Date.now();
          clearTimeout(killTimer);
          if (streaming && settled) void this.finishStream(live);
          settle();
        });
      }, reject);
    });
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
    live.child.kill();
    return true;
  }

  stopAll(): void {
    for (const live of this.runs.values()) if (live.running) live.child.kill();
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
