import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostEventMessage, RunnerOutputChunk, RunnerTask, WorkspaceInfo } from '@quiver/core';
import { until, type SmokeSection } from '../../part';

interface Discovered {
  source: string;
  name: string;
  command: string;
  cwd: string;
  file: string;
  taskId?: string;
}

// A project with one of everything discovery reads: a root package.json with npm workspaces and a lockfile, a
// workspace package, a Makefile, a justfile and a compose file. In a folder of its own, so the files do not show up
// in the other parts' workspace.
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'fixture',
    workspaces: ['packages/*', '!packages/ignored'],
    scripts: { hello: 'echo hello-from-npm', prebuild: 'echo pre', build: 'echo build', postinstall: 'echo nope' },
  }),
  'package-lock.json': '{}',
  'packages/web/package.json': JSON.stringify({ name: '@fixture/web', scripts: { dev: 'echo dev' } }),
  'packages/ignored/package.json': JSON.stringify({ name: 'ignored', scripts: { skip: 'echo skip' } }),
  'node_modules/dep/package.json': JSON.stringify({ name: 'dep', scripts: { dep: 'echo dep' } }),
  Makefile: '.PHONY: test\nCC := gcc\ntest: build\n\techo test\nlint:\n\techo lint\n%.o: %.c\n',
  justfile: 'set shell := ["bash", "-c"]\nalias s := serve\nserve port="8080":\n  echo {{port}}\n_hidden:\n  echo no\n',
  'compose.yaml': 'services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n',
};

const section: SmokeSection = async ({ host, check, run, ws, rpc, toolNames }) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-runner-tasks-'));
  for (const [file, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await fs.writeFile(path.join(folder, file), text);
  }
  const fx = await run<WorkspaceInfo>('workspace.open', { path: folder }, null);
  const events: HostEventMessage<'runner.changed'>['payload'][] = [];
  const emit = host.emit.bind(host);
  host.emit = ((event, payload) => {
    if (event === 'runner.changed') events.push(payload as HostEventMessage<'runner.changed'>['payload']);
    emit(event, payload);
  }) as typeof host.emit;

  try {
    // ---------- discovery ----------
    const found = await run<Discovered[]>('runner.task.discover', {}, fx.id);
    const key = (d: Discovered) => `${d.source} ${d.name} | ${d.command} | ${d.cwd} | ${d.file}`;
    const keys = found.map(key);
    const expected = [
      'npm hello | npm run hello |  | package.json',
      'npm build | npm run build |  | package.json',
      'make test | make test |  | Makefile',
      'make lint | make lint |  | Makefile',
      'just serve | just serve |  | justfile',
      'compose db | docker compose -f compose.yaml up db |  | compose.yaml',
      'compose cache | docker compose -f compose.yaml up cache |  | compose.yaml',
      'npm @fixture/web: dev | npm run dev | packages/web | packages/web/package.json',
    ];
    check('runner: discovery finds npm scripts, Makefile targets, just recipes, compose services and workspace packages', JSON.stringify(keys) === JSON.stringify(expected), keys);
    check('runner: discovery leaves out hooks, lifecycle scripts, private recipes, excluded packages and node_modules', !found.some((d) => /prebuild|postinstall|_hidden|skip|dep|alias|%/.test(d.name)), keys);

    // ---------- save, list, get ----------
    const hello = found.find((d) => d.name === 'hello')!;
    const saved = await run<RunnerTask>('runner.task.save', { task: hello }, fx.id);
    check('runner: a discovered script saves as a task', Boolean(saved.id) && saved.name === 'hello' && saved.command === 'npm run hello' && saved.source === 'npm' && saved.cwd === '' && !('file' in saved), saved);
    const onDisk = JSON.parse(await fs.readFile(path.join(folder, '.quiver', 'runner', `${saved.id}.json`), 'utf8')) as RunnerTask;
    check('runner: the task is committed as .quiver/runner/<id>.json', onDisk.command === 'npm run hello' && onDisk.id === saved.id, onDisk);
    const twice = await run<RunnerTask>('runner.task.save', { task: hello }, fx.id);
    check('runner: saving the same discovered script again keeps one task', twice.id === saved.id);
    const marked = (await run<Discovered[]>('runner.task.discover', {}, fx.id)).find((d) => d.name === 'hello');
    check('runner: discovery marks a script that is saved already', marked?.taskId === saved.id, marked);
    const custom = await run<RunnerTask>('runner.task.save', { task: { name: 'Web dev', command: 'echo dev', cwd: 'packages\\web', readyPattern: 'ready', port: 4321, autoRestart: true } }, fx.id);
    check('runner: a task saves with its folder, ready pattern, port and auto restart', custom.source === 'saved' && custom.cwd === 'packages/web' && custom.port === 4321 && custom.readyPattern === 'ready' && custom.autoRestart, custom);
    const cleared = await run<RunnerTask>('runner.task.save', { task: { id: custom.id, port: null, readyPattern: '' } }, fx.id);
    check('runner: an update keeps the other fields and clears port and ready pattern', cleared.port === undefined && cleared.readyPattern === undefined && cleared.command === 'echo dev' && cleared.name === 'Web dev', cleared);
    const list = await run<RunnerTask[]>('runner.task.list', {}, fx.id);
    check('runner: list gives the saved tasks by name', list.map((t) => t.name).join(',') === 'hello,Web dev', list.map((t) => t.name));
    const got = await run<RunnerTask>('runner.task.get', { id: custom.id }, fx.id);
    check('runner: get gives one task', got.id === custom.id && got.cwd === 'packages/web');
    const refusals = await Promise.all(
      [
        { task: { name: 'empty', command: '  ' } },
        { task: { command: 'echo', cwd: '../outside' } },
        { task: { command: 'echo', readyPattern: '(a+)+$' } },
      ].map((input) => run('runner.task.save', input, fx.id).then(() => '', (err: Error) => err.message)),
    );
    check('runner: save refuses an empty command, a folder outside the workspace and a pattern that could backtrack forever', /command/.test(refusals[0]) && /outside/.test(refusals[1]) && /repeats/.test(refusals[2]), refusals);
    let missing = '';
    await run('runner.task.get', { id: 'no-such-task' }, fx.id).catch((err: Error) => (missing = err.message));
    check('runner: get of a task that is not saved fails', missing.includes('no-such-task'), missing);
    check('runner: saves are announced as runner.changed tasks', events.some((e) => e.reason === 'tasks' && e.workspaceId === fx.id && e.taskId === saved.id));

    // ---------- a saved task starts ----------
    await run('runner.proc.start', { taskId: saved.id }, fx.id);
    const ran = await until(async () => {
      const out = await run<RunnerOutputChunk>('runner.proc.output', { taskId: saved.id, after: 0, limit: 500 }, fx.id);
      return out.lines.some((l) => l.text.includes('hello-from-npm'));
    }, 30_000);
    check('runner: a saved discovered task starts through runner.proc.start', ran);

    // ---------- delete stops a running task first ----------
    const long = await run<RunnerTask>('runner.task.save', { task: { name: 'long', command: `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`, env: [{ id: 'n', key: 'ELECTRON_RUN_AS_NODE', value: '1', enabled: true }] } }, fx.id);
    const started = await run<{ pid?: number }>('runner.proc.start', { taskId: long.id }, fx.id);
    const removed = await run<{ deleted: boolean; stopped: { state: string } | null }>('runner.task.delete', { id: long.id }, fx.id);
    check('runner: deleting a running task stops it first', removed.deleted && removed.stopped?.state === 'exited' && Boolean(started.pid), removed);
    const gone = await run<{ deleted: boolean; stopped: unknown }>('runner.task.delete', { id: custom.id }, fx.id);
    const left = await run<RunnerTask[]>('runner.task.list', {}, fx.id);
    check('runner: delete removes the task file', gone.deleted && gone.stopped === null && left.map((t) => t.id).join() === saved.id, left);
  } finally {
    host.emit = emit;
    await run('workspace.close', { id: fx.id }, null).catch(() => undefined);
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---------- agents over MCP, in the shared workspace ----------
  check('mcp lists runner task tools', ['runner_task_list', 'runner_task_discover', 'runner_task_get', 'runner_task_save', 'runner_task_delete'].every((n) => toolNames.includes(n)));
  const mcpList = await rpc('tools/call', { name: 'runner_task_list', arguments: {} });
  const mcpDiscover = await rpc('tools/call', { name: 'runner_task_discover', arguments: {} });
  check('mcp lists and discovers tasks', mcpList.result?.isError !== true && mcpDiscover.result?.isError !== true && Array.isArray(JSON.parse(mcpDiscover.result?.content?.[0]?.text ?? 'null')));
  for (const [tool, args] of [
    ['runner_task_save', { task: { name: 'agent', command: 'echo agent' } }],
    ['runner_task_delete', { id: 'smoke-srv' }],
  ] as const) {
    const blocked = await rpc('tools/call', { name: tool, arguments: args });
    check(`mcp blocks ${tool} by default`, blocked.result?.isError === true && (blocked.result.content?.[0]?.text ?? '').includes('MUTATION_BLOCKED'));
  }
  const agentSaved = (await run<RunnerTask[]>('runner.task.list', {}, ws.id)).some((t) => t.name === 'agent');
  check('runner: a blocked agent save wrote nothing', !agentSaved);
};

export default section;
