// `quiver`: run any Quiver command from a terminal or CI (docs/cli.md). Built to out/main/cli.js; the packaged
// shims in resources/cli run it with the app's own Node (ELECTRON_RUN_AS_NODE=1), `npm run cli --` with Node.
// Nothing here or in what it imports may load Electron: headless runs boot the Host in plain Node.
import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CLI_EXIT, CliUsageError, exampleFor, exitCodeForError, fieldsToInput, junitReport, parseCliArgs, resultFailures, type ApiRun, type JsonSchema, type ParsedCli } from '@quiver/core';
import type { CliOutcome } from '@quiver/mcp';
import { Output, USAGE, formatDescribe, formatList, formatRun, type CommandRow, type Described } from './output';
import { UnreachableError, appUserDataDir, connect, headlessDataDir, type Transport } from './transport';

/** The version of the build this script belongs to: the package.json beside out/. */
function cliVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The project a call runs in: --workspace, or the nearest folder up from here that holds a `.quiver` folder. */
function findWorkspace(given: string | undefined): string | null {
  if (given) return path.resolve(given);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    try {
      if (statSync(path.join(dir, '.quiver')).isDirectory()) return dir;
    } catch {
      // Not here; look one folder up.
    }
    if (path.dirname(dir) === dir) return null;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** `--input` as an object: JSON text, `@file.json` or `@-` for stdin. */
async function readInput(source: string | undefined): Promise<Record<string, unknown>> {
  if (source === undefined) return {};
  let text = source;
  if (source.startsWith('@')) {
    const file = source.slice(1);
    try {
      text = file === '-' ? await readStdin() : await fs.readFile(path.resolve(file), 'utf8');
    } catch (err) {
      throw new CliUsageError(`--input ${source}: ${(err as Error).message}`);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CliUsageError(`--input is not valid JSON: ${(err as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliUsageError('--input must be a JSON object');
  return value as Record<string, unknown>;
}

/** An error as the CLI prints it: the host's, or TIMEOUT when the deadline passed. */
interface CliError {
  code: string;
  message: string;
  details?: unknown;
}

class CommandFailed extends Error {
  constructor(readonly error: CliError) {
    super(error.message);
  }
}

/** A call that fails with the host's error, and gives up at the deadline. */
async function call<T>(transport: Transport, deadline: Deadline, command: string, input: unknown, workspace: string | null): Promise<T> {
  let outcome: CliOutcome;
  try {
    outcome = await transport.call(command, input, workspace, deadline.signal);
  } catch (err) {
    if (deadline.signal?.aborted) throw new CommandFailed({ code: 'TIMEOUT', message: `No answer within ${deadline.label}` });
    throw err;
  }
  if (!outcome.ok) throw new CommandFailed(outcome.error);
  return outcome.result as T;
}

interface Deadline {
  signal?: AbortSignal;
  label: string;
}

/** A collection run answers at once with its id; the CLI follows it to the end, so the result is the finished run. */
async function followRun(transport: Transport, deadline: Deadline, runId: string, workspace: string | null): Promise<ApiRun> {
  // Ctrl+C stops the requests still to go too, rather than leave them running in the app.
  interrupt = () => transport.call('api.run.cancel', { runId }, workspace, AbortSignal.timeout(2000));
  try {
    for (;;) {
      let run: ApiRun;
      try {
        run = await call<ApiRun>(transport, deadline, 'api.run.get', { runId }, workspace);
      } catch (err) {
        if (err instanceof CommandFailed && err.error.code === 'TIMEOUT') {
          // Stop the requests still to go rather than leave them running in the app.
          await transport.call('api.run.cancel', { runId }, workspace, AbortSignal.timeout(2000)).catch(() => undefined);
        }
        throw err;
      }
      if (run.finishedAt) return run;
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    interrupt = undefined;
  }
}

/** What to stop before exiting on Ctrl+C (or a CI runner's SIGTERM): the collection run being followed. */
let interrupt: (() => Promise<unknown>) | undefined;
let interrupted = false;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(signal, () => {
    // A second Ctrl+C does not wait for the first one's cancel.
    if (interrupted || !interrupt) process.exit(code);
    interrupted = true;
    void interrupt()
      .catch(() => undefined)
      .finally(() => process.exit(code));
  });
}

/** The Host and every module load only for a headless run; connected calls start without them. */
async function headless(dataDir: string, secretsFile: string | undefined, version: string): Promise<Transport> {
  return (await import('./headless')).headless(dataDir, secretsFile, version);
}

async function open(parsed: ParsedCli, version: string): Promise<Transport> {
  const { options } = parsed;
  if (options.headless === 'on') return headless(headlessDataDir(options.dataDir), options.secrets, version);
  try {
    return await connect(appUserDataDir(options.userDataDir));
  } catch (err) {
    if (err instanceof UnreachableError && options.headless === 'auto') return headless(headlessDataDir(options.dataDir), options.secrets, version);
    throw err;
  }
}

async function main(argv: string[]): Promise<number> {
  const version = cliVersion();
  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    await new Output(false, false).usage((err as Error).message);
    return CLI_EXIT.usage;
  }
  const { options } = parsed;
  const out = new Output(options.json ?? !process.stdout.isTTY, options.quiet);
  if (parsed.verb === 'help') {
    await out.write(USAGE);
    return CLI_EXIT.ok;
  }
  if (parsed.verb === 'version') {
    await out.write(out.json ? JSON.stringify({ version }) : version);
    return CLI_EXIT.ok;
  }
  if (options.reporter && parsed.target !== 'api.collection.run') {
    await out.usage('--reporter junit is for api.collection.run');
    return CLI_EXIT.usage;
  }
  if (options.out && !options.reporter) {
    await out.usage('--out goes with --reporter');
    return CLI_EXIT.usage;
  }
  if (options.headless === 'off' && (options.dataDir || options.secrets)) {
    await out.usage('--data-dir and --secrets are for headless runs; add --headless');
    return CLI_EXIT.usage;
  }

  // Module logs of a headless Host go to stderr, so stdout carries only the result; --quiet drops the chatter.
  const log = options.quiet ? () => {} : (...args: unknown[]) => console.error(...args);
  console.log = log;
  console.info = log;
  console.debug = log;

  let transport: Transport | undefined;
  const controller = options.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs) : undefined;
  const deadline: Deadline = { signal: controller?.signal, label: options.timeoutMs ? `${options.timeoutMs / 1000} s` : '' };
  try {
    transport = await open(parsed, version);
    const workspace = findWorkspace(options.workspace) ?? (transport.mode === 'headless' ? process.cwd() : null);

    if (parsed.verb === 'list') {
      const rows = await call<CommandRow[]>(transport, deadline, 'cli.commands', { module: parsed.target, all: options.all }, null);
      if (!out.quiet) await (out.json ? out.result(rows) : out.write(formatList(rows)));
      return CLI_EXIT.ok;
    }
    if (parsed.verb === 'describe') {
      const described = await call<Described>(transport, deadline, 'cli.describe', { id: parsed.target }, null);
      if (!out.quiet) await (out.json ? out.result({ ...described, example: exampleFor(described.id, described.input) }) : out.write(formatDescribe(described)));
      return CLI_EXIT.ok;
    }

    const command = parsed.target!;
    let input = await readInput(options.input);
    if (parsed.fields.length) {
      const described = await call<{ input: JsonSchema }>(transport, deadline, 'cli.describe', { id: command }, null);
      input = fieldsToInput(parsed.fields, described.input, input, command);
    }
    let result = await call<unknown>(transport, deadline, command, input, workspace);
    if (command === 'api.collection.run') {
      const run = await followRun(transport, deadline, (result as { runId: string }).runId, workspace);
      result = run;
      if (options.reporter === 'junit') {
        const xml = junitReport([run]);
        if (options.out) await fs.writeFile(path.resolve(options.out), xml);
        else await out.write(xml);
      }
      if (!options.reporter || options.out) await (out.json || out.quiet ? out.result(run) : out.write(formatRun(run)));
    } else await out.result(result);
    return resultFailures(result) > 0 ? CLI_EXIT.checksFailed : CLI_EXIT.ok;
  } catch (err) {
    if (err instanceof CommandFailed) {
      await out.error(err.error);
      return exitCodeForError(err.error.code);
    }
    if (err instanceof CliUsageError) {
      await out.usage(err.message);
      return CLI_EXIT.usage;
    }
    if (err instanceof UnreachableError) {
      await out.usage(err.message);
      return CLI_EXIT.unreachable;
    }
    await out.error({ code: 'INTERNAL', message: (err as Error).message });
    return CLI_EXIT.failed;
  } finally {
    if (timer) clearTimeout(timer);
    await transport?.close().catch(() => undefined);
  }
}

// Exit as soon as the answer is out: a headless Host leaves watchers and timers behind that would keep Node alive.
void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`quiver: ${(err as Error).stack ?? err}\n`, () => process.exit(CLI_EXIT.failed));
  },
);
