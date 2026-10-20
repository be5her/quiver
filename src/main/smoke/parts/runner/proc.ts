import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostEventMessage, RunnerOutputChunk, RunnerOutputLine, RunnerTask, WorkspaceInfo } from '@quiver/core';
import { freePort, processAlive, until, type SmokeSection } from '../../part';

interface Proc {
  taskId: string;
  runId: string;
  state: string;
  pid?: number;
  exitCode?: number | null;
  restarts: number;
  port?: number;
  uptimeMs?: number;
  restartAt?: string;
}

interface Waited {
  matched: boolean;
  timedOut: boolean;
  line?: RunnerOutputLine;
  proc: Proc | null;
}

// A dev server stand-in: starts a grandchild (to check the whole tree is stopped), prints "ready on <port>" once it
// listens, leaves a prompt without a line break, and answers stdin: `crash` exits with 3, `burst` prints 6000 lines,
// anything else is echoed. Run by Electron's own binary as Node, so the smoke needs no Node on PATH.
const FIXTURE = `
const net = require('net');
const cp = require('child_process');
const port = Number(process.argv[2]);
const kid = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: process.env });
console.log('grandchild ' + kid.pid);
console.error('warming up');
net.createServer((s) => s.end()).listen(port, '127.0.0.1', () => {
  console.log('\\u001b[32mready\\u001b[39m on ' + port);
  process.stdout.write('prompt> ');
});
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'crash') { console.error('crashing'); kid.kill(); process.exit(3); }
    else if (line === 'burst') { let s = ''; for (let n = 0; n < 6000; n++) s += 'line ' + n + '\\n'; process.stdout.write(s); }
    else console.log('echo ' + line);
  }
});
`;

const section: SmokeSection = async ({ host, check, run, ws, folder, rpc, toolNames }) => {
  const store = host.workspaces.get(ws.id)!.store;
  await fs.writeFile(path.join(folder, 'runner-fixture.cjs'), FIXTURE);
  const node = `"${process.execPath}"`;
  const asNode = [{ id: 'n', key: 'ELECTRON_RUN_AS_NODE', value: '1', enabled: true }];
  const task = (t: Partial<RunnerTask> & Pick<RunnerTask, 'id' | 'command'>): RunnerTask => ({ name: t.id, cwd: '', env: [], autoRestart: false, source: 'saved', ...t });
  const port = await freePort();
  const port2 = await freePort();
  await store.put('runner', task({ id: 'smoke-srv', command: `${node} runner-fixture.cjs ${port}`, env: asNode, readyPattern: 'ready on \\d+', autoRestart: true, port }));
  await store.put('runner', task({ id: 'smoke-port', command: `${node} runner-fixture.cjs ${port2}`, env: asNode, port: port2 }));
  await store.put('runner', task({ id: 'smoke-echo', command: 'echo hello from %RUNNER_WORD%$RUNNER_WORD', env: [{ id: 'w', key: 'RUNNER_WORD', value: 'quiver', enabled: true }] }));
  await store.put('runner', task({ id: 'smoke-bad', command: 'exit 7' }));

  // Count what the supervisor announces.
  // Count what the supervisor announces, and look at the task the moment its state changes: a state that lasts a
  // second (crashed, before the restart) is easily missed by polling on a busy machine.
  const events: HostEventMessage<'runner.changed'>['payload'][] = [];
  const seen: Proc[] = [];
  const emit = host.emit.bind(host);
  host.emit = ((event, payload) => {
    if (event === 'runner.changed') {
      const e = payload as HostEventMessage<'runner.changed'>['payload'];
      events.push(e);
      if (e.reason === 'state' && e.workspaceId === ws.id && e.taskId) {
        void host.invoke('runner.proc.list', {}, { caller: 'ui', workspaceId: ws.id }).then((out) => {
          const proc = out.ok ? (out.result as Proc[]).find((p) => p.taskId === e.taskId) : undefined;
          if (proc) seen.push(proc);
        });
      }
    }
    emit(event, payload);
  }) as typeof host.emit;

  try {
    const output = (taskId: string, after = 0, limit = 5000) => run<RunnerOutputChunk>('runner.proc.output', { taskId, after, limit }, ws.id);
    const wait = (taskId: string, pattern?: string, timeoutMs = 15_000) => run<Waited>('runner.proc.wait', { taskId, pattern, timeoutMs }, ws.id);
    const grandchild = async (taskId: string) => Number(/grandchild (\d+)/.exec((await output(taskId)).lines.map((l) => l.text).join('\n'))?.[1]);

    // ---------- start, ready by pattern, output, cursor, stdin ----------
    const started = await run<Proc>('runner.proc.start', { taskId: 'smoke-srv' }, ws.id);
    check('runner: start answers the new run, starting, with its pid and port', started.state === 'starting' && Boolean(started.pid) && started.port === port && started.restarts === 0, started);
    const again = await run<Proc>('runner.proc.start', { taskId: 'smoke-srv' }, ws.id);
    check('runner: starting a running task leaves it alone', again.runId === started.runId && again.pid === started.pid);
    const ready = await wait('smoke-srv');
    check('runner: a task is ready once its ready pattern prints, colour codes aside', ready.matched && ready.proc?.state === 'ready' && ready.proc.runId === started.runId, ready);
    const listed = (await run<Proc[]>('runner.proc.list', {}, ws.id)).find((p) => p.taskId === 'smoke-srv');
    check('runner: list carries state, pid, port and uptime', listed?.state === 'ready' && listed.pid === started.pid && listed.port === port && typeof listed.uptimeMs === 'number', listed);
    const prompt = await wait('smoke-srv', '^prompt> $', 3000);
    check('runner: text without a line break (a prompt) shows up after a pause', prompt.matched, prompt);
    const first = await output('smoke-srv');
    const kinds = new Set(first.lines.map((l) => l.stream));
    check(
      'runner: output keeps stdout, stderr and the command line, numbered from 1',
      first.lines[0]?.seq === 1 && first.lines[0].stream === 'system' && first.lines[0].text.includes('runner-fixture.cjs') && kinds.has('stdout') && kinds.has('stderr') && first.dropped === 0 && first.next === first.lines.at(-1)?.seq,
      first.lines.map((l) => [l.seq, l.stream, l.text]),
    );
    const empty = await output('smoke-srv', first.next);
    check('runner: reading on from the cursor gives only what is new', empty.lines.length === 0 && empty.next === first.next);
    const grand = await grandchild('smoke-srv');
    check('runner: the fixture started a grandchild', processAlive(grand), grand);
    await run('runner.proc.input', { taskId: 'smoke-srv', text: 'hello agent\n' }, ws.id);
    const echoed = await wait('smoke-srv', 'echo hello agent', 5000);
    const after = await output('smoke-srv', first.next);
    check('runner: input goes to stdin, and the answer is read from the cursor on', echoed.matched && after.lines.some((l) => l.text === 'echo hello agent') && after.lines[0].seq === first.next + 1, after.lines);
    const timedOut = await wait('smoke-srv', 'never printed', 300);
    check('runner: wait gives up after its timeout', timedOut.timedOut && !timedOut.matched && timedOut.proc?.state === 'ready');

    // ---------- the ring buffer and throttled output events ----------
    const outputEventsBefore = events.filter((e) => e.reason === 'output').length;
    const burstAt = Date.now();
    await run('runner.proc.input', { taskId: 'smoke-srv', text: 'burst\n' }, ws.id);
    await wait('smoke-srv', '^line 5999$', 10_000);
    await new Promise((r) => setTimeout(r, 400));
    const burstMs = Date.now() - burstAt;
    const outputEvents = events.filter((e) => e.reason === 'output').length - outputEventsBefore;
    check('runner: output events are throttled to four a second', outputEvents >= 1 && outputEvents <= Math.ceil(burstMs / 250) + 1, { outputEvents, burstMs });
    const full = await output('smoke-srv');
    check('runner: a run keeps its last 5000 lines and counts what fell out', full.lines.length === 5000 && full.dropped > 0 && full.lines.at(-1)?.text === 'line 5999' && full.lines[0].seq === full.dropped + 1, { n: full.lines.length, dropped: full.dropped });
    const page = await output('smoke-srv', 0, 10);
    check('runner: reads are paged by limit', page.lines.length === 10 && page.next === page.lines[9].seq);

    // ---------- crash and automatic restart with backoff ----------
    const crashAt = Date.now();
    await run('runner.proc.input', { taskId: 'smoke-srv', text: 'crash\n' }, ws.id);
    const crashed = await until(() => seen.some((p) => p.taskId === 'smoke-srv' && p.state === 'crashed' && p.exitCode === 3 && Boolean(p.restartAt)), 5000);
    check('runner: a crash is reported with a restart pending', crashed);
    const back = await until(async () => (await run<Proc[]>('runner.proc.list', {}, ws.id)).some((p) => p.taskId === 'smoke-srv' && p.state === 'ready' && p.restarts === 1), 15_000);
    const restarted = (await run<Proc[]>('runner.proc.list', {}, ws.id)).find((p) => p.taskId === 'smoke-srv');
    check('runner: auto restart starts the crashed task again after a backoff, in the same run', back && restarted?.runId === started.runId && restarted.pid !== started.pid && Date.now() - crashAt >= 900, restarted);
    const crashLog = (await output('smoke-srv')).lines.map((l) => l.text);
    check('runner: the output notes the exit and the restart', crashLog.some((t) => t.includes('exited with code 3')) && crashLog.some((t) => /Restarting in 1 s/.test(t)));

    // ---------- agents over MCP ----------
    check('mcp lists runner process tools', ['runner_proc_list', 'runner_proc_start', 'runner_proc_stop', 'runner_proc_restart', 'runner_proc_output', 'runner_proc_wait', 'runner_proc_input'].every((n) => toolNames.includes(n)));
    const mcpOut = await rpc('tools/call', { name: 'runner_proc_output', arguments: { taskId: 'smoke-srv', after: 0, limit: 5 } });
    check('mcp reads task output', mcpOut.result?.isError !== true && (JSON.parse(mcpOut.result?.content?.[0]?.text ?? '{}') as RunnerOutputChunk).lines?.length === 5);
    const mcpWait = await rpc('tools/call', { name: 'runner_proc_wait', arguments: { taskId: 'smoke-srv', timeoutMs: 2000 } });
    check('mcp can wait for a task', (JSON.parse(mcpWait.result?.content?.[0]?.text ?? '{}') as Waited).matched === true);
    for (const [tool, args] of [
      ['runner_proc_start', { taskId: 'smoke-port' }],
      ['runner_proc_stop', { taskId: 'smoke-srv' }],
      ['runner_proc_restart', { taskId: 'smoke-srv' }],
      ['runner_proc_input', { taskId: 'smoke-srv', text: 'crash\n' }],
    ] as const) {
      const blocked = await rpc('tools/call', { name: tool, arguments: args });
      check(`mcp blocks ${tool} by default`, blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
    }

    // ---------- stop kills the whole tree; restart is a new run ----------
    const pidBeforeRestart = restarted?.pid;
    const grandAfterRestart = await grandchild('smoke-srv');
    const viaRestart = await run<Proc>('runner.proc.restart', { taskId: 'smoke-srv' }, ws.id);
    check('runner: restart starts a new run', viaRestart.runId !== started.runId && viaRestart.restarts === 0 && viaRestart.pid !== pidBeforeRestart);
    check('runner: restart stopped the old tree first', !processAlive(pidBeforeRestart) && (await until(() => !processAlive(grandAfterRestart), 3000)), { pidBeforeRestart, grandAfterRestart });
    await wait('smoke-srv');
    const grandNow = await grandchild('smoke-srv');
    const stopped = await run<Proc>('runner.proc.stop', { taskId: 'smoke-srv' }, ws.id);
    check('runner: stop waits for the exit and is not a crash', stopped.state === 'exited' && !processAlive(viaRestart.pid), stopped);
    check('runner: stop kills the process tree, grandchildren too', await until(() => !processAlive(grandNow) && !processAlive(grand), 3000), { grandNow, grand });
    await new Promise((r) => setTimeout(r, 1500));
    const stays = (await run<Proc[]>('runner.proc.list', {}, ws.id)).find((p) => p.taskId === 'smoke-srv');
    check('runner: a stopped task with auto restart stays stopped', stays?.state === 'exited' && stays.runId === viaRestart.runId);
    const oldRun = await run<RunnerOutputChunk>('runner.proc.output', { taskId: 'smoke-srv', runId: started.runId, after: 0, limit: 1 }, ws.id);
    check('runner: the output of an earlier run stays readable by its id', oldRun.runId === started.runId && oldRun.lines.length === 1);

    // ---------- ready by port, plain commands, a failing command ----------
    await run('runner.proc.start', { taskId: 'smoke-port' }, ws.id);
    const byPort = await wait('smoke-port');
    check('runner: a task with a port is ready once the port accepts connections', byPort.matched && byPort.proc?.state === 'ready', byPort);
    const portTree = [byPort.proc?.pid, await grandchild('smoke-port')];
    await run('runner.proc.start', { taskId: 'smoke-echo' }, ws.id);
    const echoDone = await until(async () => (await run<Proc[]>('runner.proc.list', {}, ws.id)).some((p) => p.taskId === 'smoke-echo' && p.state === 'exited' && p.exitCode === 0), 5000);
    const echoText = (await output('smoke-echo')).lines.map((l) => l.text).join('\n');
    check('runner: a command runs through the shell with the task env and exits cleanly', echoDone && echoText.includes('quiver'), echoText);
    await run('runner.proc.start', { taskId: 'smoke-bad' }, ws.id);
    const bad = await wait('smoke-bad', 'never printed', 5000);
    check('runner: a failing command is crashed with its exit code, and a wait on it ends early', !bad.matched && !bad.timedOut && bad.proc?.state === 'crashed' && bad.proc.exitCode === 7, bad);
    let missing = '';
    await run('runner.proc.start', { taskId: 'no-such-task' }, ws.id).catch((err: Error) => (missing = err.message));
    check('runner: starting a task that is not saved fails', missing.includes('no-such-task'), missing);
    await run('runner.proc.stop', { taskId: 'smoke-port' }, ws.id);
    check('runner: the port task is stopped too', await until(() => portTree.every((pid) => !processAlive(pid)), 3000), portTree);

    // ---------- closing the workspace kills its processes ----------
    const otherFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-runner-'));
    await fs.writeFile(path.join(otherFolder, 'runner-fixture.cjs'), FIXTURE);
    const other = await run<WorkspaceInfo>('workspace.open', { path: otherFolder }, null);
    const otherPort = await freePort();
    await host.workspaces.get(other.id)!.store.put('runner', task({ id: 'smoke-close', command: `${node} runner-fixture.cjs ${otherPort}`, env: asNode, readyPattern: 'ready on' }));
    const closing = await run<Proc>('runner.proc.start', { taskId: 'smoke-close' }, other.id);
    await run('runner.proc.wait', { taskId: 'smoke-close', timeoutMs: 15_000 }, other.id);
    const closeGrand = Number(/grandchild (\d+)/.exec((await run<RunnerOutputChunk>('runner.proc.output', { taskId: 'smoke-close', after: 0, limit: 50 }, other.id)).lines.map((l) => l.text).join('\n'))?.[1]);
    await run('workspace.close', { id: other.id }, null);
    check('runner: closing the workspace kills its process trees', await until(() => !processAlive(closing.pid) && !processAlive(closeGrand), 5000), { pid: closing.pid, closeGrand });
    await fs.rm(otherFolder, { recursive: true, force: true }).catch(() => undefined);

    check('runner: state changes are announced per task and run', events.some((e) => e.reason === 'state' && e.taskId === 'smoke-srv' && e.runId === started.runId && e.workspaceId === ws.id));
  } finally {
    host.emit = emit;
    for (const taskId of ['smoke-srv', 'smoke-port']) await run('runner.proc.stop', { taskId }, ws.id).catch(() => undefined);
  }
};

export default section;
