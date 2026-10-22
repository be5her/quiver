import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { CLI_EXIT, CLI_TOKEN_HEADER, keyValue, newApiRequest, newCollection, newEnvironment, type ApiRun, type Check, type Environment, type GitStatus, type TodoItem, type WorkspaceInfo } from '@quiver/core';
import { runToEnd } from '@quiver/core/node';
import { CLI_ENDPOINT_FILE, CLI_TOKEN_FILE, type CliEndpointInfo } from '../../cli-files';
import { definePart } from '../part';

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The built CLI, run the way the packaged shims run it: this Electron as plain Node on out/main/cli.js. */
function quiver(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env };
  for (const key of Object.keys(childEnv)) if (key.startsWith('QUIVER_SMOKE') || key.startsWith('QUIVER_SECRET_')) delete childEnv[key];
  Object.assign(childEnv, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(app.getAppPath(), 'out', 'main', 'cli.js'), ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function json<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const check200 = (id: string, expected = '200'): Check => ({ id, enabled: true, on: 'status', path: '', op: 'eq', expected });

export default definePart({
  name: 'cli',
  summary: 'Command line: connected and headless runs, the token and Origin checks, exit codes, JUnit',
  async run(t) {
    const { host, check, run, ws, folder, fixtures } = t;
    const userData = host.api.dataDir!;
    const connected = (args: string[], env?: Record<string, string>) => quiver(['--user-data-dir', userData, '--json', ...args], env);

    // Headless runs boot the host in plain Node: nothing the CLI loads, up to every chunk it requires, may load Electron.
    const built = path.join(app.getAppPath(), 'out', 'main');
    const loaded: string[] = [];
    const electronIn: string[] = [];
    for (const queue = ['cli.js']; queue.length; ) {
      const file = queue.shift()!;
      if (loaded.includes(file)) continue;
      loaded.push(file);
      const code = await fs.readFile(path.join(built, file), 'utf8');
      if (/require\(["']electron["']\)/.test(code)) electronIn.push(file);
      for (const m of code.matchAll(/require\(["']\.\/((?:chunks\/)?[\w.-]+\.js)["']\)/g)) queue.push(path.posix.join(path.posix.dirname(file), m[1]));
    }
    check('cli: the built command line and the chunks it loads never require Electron', loaded.length > 1 && electronIn.length === 0, { loaded, electronIn });

    // ---------- connected mode ----------

    // The app publishes where it listens and a fresh token, readable by the user only.
    const info = json<CliEndpointInfo>(await fs.readFile(path.join(userData, CLI_ENDPOINT_FILE), 'utf8'));
    const token = (await fs.readFile(path.join(userData, CLI_TOKEN_FILE), 'utf8')).trim();
    const tokenMode = process.platform === 'win32' ? 0o600 : (await fs.stat(path.join(userData, CLI_TOKEN_FILE))).mode & 0o777;
    check(
      'cli: the app publishes its port and a random token, readable by the user only',
      info?.port === t.mcpPort && info.pid === process.pid && /^[0-9a-f]{64}$/.test(token) && tokenMode === 0o600,
      { info, tokenLength: token.length, tokenMode: tokenMode.toString(8) },
    );

    const listed = await connected(['list']);
    const rows = json<{ id: string; mutating: boolean; hidden: boolean }[]>(listed.stdout) ?? [];
    const todoOnly = json<{ id: string }[]>((await connected(['list', 'todo'])).stdout) ?? [];
    const withHidden = json<{ id: string }[]>((await connected(['list', '--all'])).stdout) ?? [];
    check(
      'cli: list gives every command with whether it changes data, a module filter, hidden ones only with --all',
      listed.code === 0 &&
        rows.find((r) => r.id === 'todo.add')?.mutating === false &&
        rows.find((r) => r.id === 'todo.remove')?.mutating === true &&
        !rows.some((r) => r.hidden || r.id === 'config.update') &&
        todoOnly.length > 0 &&
        todoOnly.every((r) => r.id.startsWith('todo.')) &&
        withHidden.some((r) => r.id === 'config.update'),
      { code: listed.code, count: rows.length, todo: todoOnly.map((r) => r.id), stderr: listed.stderr },
    );

    const described = await connected(['describe', 'todo.add']);
    const description = json<{ id: string; input: { properties?: Record<string, unknown>; required?: string[] }; example: { args: string[] } }>(described.stdout);
    check(
      'cli: describe gives the input schema and an example',
      described.code === 0 && Boolean(description?.input.properties?.title) && description?.input.required?.includes('title') === true && description.example.args.join(' ') === 'quiver todo.add --title <string>',
      { code: described.code, description, stderr: described.stderr },
    );

    // A read command in the workspace, with the secret unmasked: the CLI is the user, not an agent.
    const envs = await connected(['api.environment.list', '--workspace', folder]);
    const local = (json<Environment[]>(envs.stdout) ?? []).find((e) => e.name === 'local');
    const agentEnvs = await host.invoke('api.environment.list', {}, { caller: 'mcp', workspaceId: ws.id });
    const agentToken = agentEnvs.ok ? (agentEnvs.result as Environment[]).find((e) => e.name === 'local')?.variables.find((v) => v.key === 'token')?.value : undefined;
    check(
      'cli: a read command runs in the named workspace, and secrets are not masked for the CLI as they are for agents',
      envs.code === 0 && local?.variables.find((v) => v.key === 'token')?.value === 's3cret' && agentToken !== 's3cret',
      { code: envs.code, token: local?.variables.find((v) => v.key === 'token')?.value, agentToken, stderr: envs.stderr },
    );

    // A mutating command: refused for agents while mutations are off, run for the CLI.
    const added = await connected(['todo.add', '--title', 'from the cli', '--notes', '42', '--workspace', folder]);
    const todo = json<TodoItem>(added.stdout);
    const agentRemove = await host.invoke('todo.remove', { id: todo?.id ?? '' }, { caller: 'mcp', workspaceId: ws.id });
    const removed = await connected(['todo.remove', '--id', todo?.id ?? '', '--workspace', folder]);
    const left = await run<TodoItem[]>('todo.list', {}, ws.id);
    check(
      'cli: fields become typed input, and a mutating command runs for the CLI where an agent is refused',
      added.code === 0 && todo?.title === 'from the cli' && todo.notes === '42' && (host.config.get().mcp.permissions.mode === 'allow' || (!agentRemove.ok && agentRemove.error.code === 'MUTATION_BLOCKED')) && removed.code === 0 && !left.some((i) => i.id === todo.id),
      { added: added.code, todo, agentRemove: agentRemove.ok || agentRemove.error.code, removed: removed.code, stderr: removed.stderr },
    );

    // The new git and kube commands are listed, and the CLI runs git as the user while the agent permissions refuse agents.
    const gitRows = json<{ id: string; mutating: boolean }[]>((await connected(['list', 'git'])).stdout) ?? [];
    const kubeRows = json<{ id: string; mutating: boolean }[]>((await connected(['list', 'teleport'])).stdout) ?? [];
    const describedAction = json<{ id: string; input: { properties?: Record<string, unknown> } }>((await connected(['describe', 'teleport.kube.action'])).stdout);
    check(
      'cli: list shows the git branch, stash and tag commands and the kube actions, with whether they change data, and describe gives their schema',
      ['git.branch.delete', 'git.merge', 'git.rebase', 'git.stash.push', 'git.reset', 'git.discard', 'git.tag.push'].every((id) => gitRows.find((r) => r.id === id)?.mutating === true) &&
        ['git.stash.list', 'git.tag.list', 'git.file.show'].every((id) => gitRows.find((r) => r.id === id)?.mutating === false) &&
        ['teleport.kube.action', 'teleport.kube.portForward.start'].every((id) => kubeRows.find((r) => r.id === id)?.mutating === true) &&
        kubeRows.find((r) => r.id === 'teleport.kube.action.preview')?.mutating === false &&
        Boolean(describedAction?.input.properties?.action) &&
        Boolean(describedAction?.input.properties?.confirmCluster),
      { git: gitRows.length, kube: kubeRows.map((r) => r.id), described: Boolean(describedAction) },
    );
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-cli-git-'));
    const inRepo = (...args: string[]) => runToEnd('git', args, { cwd: repo });
    await inRepo('init', '-q', '-b', 'main');
    await inRepo('config', 'user.name', 'Smoke');
    await inRepo('config', 'user.email', 'smoke@quiver.test');
    await fs.writeFile(path.join(repo, '.gitignore'), '.quiver/\n');
    await fs.writeFile(path.join(repo, 'a.txt'), 'base\n');
    await inRepo('add', '.');
    await inRepo('commit', '-q', '-m', 'Base');
    const repoWs = await run<WorkspaceInfo>('workspace.open', { path: repo }, null);
    const mcpBefore = host.config.get().mcp;
    try {
      // A strict agent setup: read-only, and a deny rule on every git tool.
      await run('config.update', { patch: { mcp: { ...mcpBefore, permissions: { mode: 'read-only', rules: [{ match: 'git.*', action: 'deny' }] } } } }, null);
      const cliStatus = await connected(['git.status', '--workspace', repo]);
      const status = json<GitStatus>(cliStatus.stdout);
      const cliBranch = await connected(['git.branch.create', '--name', 'from-cli', '--workspace', repo]);
      const branchNow = (await inRepo('branch', '--show-current')).stdout.trim();
      const agentStatus = await host.invoke('git.status', {}, { caller: 'mcp', workspaceId: repoWs.id });
      const agentBranch = await host.invoke('git.branch.create', { name: 'from-agent' }, { caller: 'mcp', workspaceId: repoWs.id });
      const reason = (r: typeof agentStatus) => (r.ok ? 'ok?' : `${r.error.code}:${(r.error.details as { reason?: string } | undefined)?.reason}`);
      check(
        'cli: git.status and a gated git write run for the CLI as the user, while a deny rule and read-only mode refuse them to agents',
        cliStatus.code === 0 &&
          status?.branch === 'main' &&
          cliBranch.code === 0 &&
          branchNow === 'from-cli' &&
          reason(agentStatus) === 'MUTATION_BLOCKED:rule' &&
          reason(agentBranch) === 'MUTATION_BLOCKED:rule' &&
          !(await inRepo('branch', '--list', 'from-agent')).stdout.trim(),
        { status: [cliStatus.code, status?.branch, cliStatus.stderr.slice(0, 200)], branch: [cliBranch.code, branchNow, cliBranch.stderr.slice(0, 200)], agent: [reason(agentStatus), reason(agentBranch)] },
      );
      // Pausing agents leaves the CLI alone.
      await run('config.update', { patch: { mcp: { ...host.config.get().mcp, paused: true } } }, null);
      const pausedStatus = await connected(['git.status', '--workspace', repo]);
      const pausedAgent = await host.invoke('git.status', {}, { caller: 'mcp', workspaceId: repoWs.id });
      check(
        'cli: pausing agents does not pause the CLI',
        pausedStatus.code === 0 && json<GitStatus>(pausedStatus.stdout)?.branch === 'from-cli' && reason(pausedAgent) === 'MUTATION_BLOCKED:paused',
        { cli: [pausedStatus.code, pausedStatus.stderr.slice(0, 200)], agent: reason(pausedAgent) },
      );
    } finally {
      await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: mcpBefore.permissions, paused: mcpBefore.paused } } }, null).catch(() => {});
      await run('workspace.close', { id: repoWs.id }, null).catch(() => {});
      await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    }

    // Exit codes: bad input and unknown fields are 2, a failing command 1 with its error as JSON on stderr.
    const badType = await connected(['todo.add', '--input', '{"title": 5}', '--workspace', folder]);
    const badField = await connected(['todo.add', '--titel', 'x', '--workspace', folder]);
    const unknown = await connected(['nope.nothing']);
    const failing = await connected(['todo.update', '--id', 'no-such-todo', '--done', '--workspace', folder]);
    check(
      'cli: invalid input and unknown fields exit 2, a failing command exits 1 with the error JSON on stderr',
      badType.code === CLI_EXIT.usage &&
        json<{ code: string }>(badType.stderr)?.code === 'INVALID_INPUT' &&
        badField.code === CLI_EXIT.usage &&
        badField.stderr.includes('Unknown field --titel') &&
        unknown.code === CLI_EXIT.usage &&
        failing.code === CLI_EXIT.failed &&
        json<{ code: string }>(failing.stderr)?.code === 'NOT_FOUND' &&
        failing.stdout === '',
      { badType: [badType.code, badType.stderr.slice(0, 120)], badField: [badField.code, badField.stderr], unknown: unknown.code, failing: [failing.code, failing.stderr] },
    );

    // The endpoint itself: only the token gets in, and never from a browser.
    const cliUrl = `http://127.0.0.1:${t.mcpPort}/cli`;
    const post = (headers: Record<string, string>) => fetch(cliUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ command: 'todo.list', input: {}, workspace: folder }) });
    const wrongToken = await post({ [CLI_TOKEN_HEADER]: 'f'.repeat(64) });
    const noToken = await post({});
    const fromBrowser = await post({ [CLI_TOKEN_HEADER]: token, origin: `http://127.0.0.1:${t.mcpPort}` });
    const right = await post({ [CLI_TOKEN_HEADER]: token });
    const rightBody = (await right.json()) as { ok: boolean };
    check(
      'cli: the endpoint refuses a wrong or missing token and any request with an Origin header',
      wrongToken.status === 401 && noToken.status === 401 && fromBrowser.status === 403 && right.status === 200 && rightBody.ok,
      { wrongToken: wrongToken.status, noToken: noToken.status, fromBrowser: fromBrowser.status, right: right.status },
    );
    // An agent that read the token file must not reach the endpoint through the API client, an open tool.
    const viaApiClient = (headerName: string, caller: 'mcp' | 'ui') =>
      host.invoke(
        'api.request.send',
        { request: newApiRequest({ method: 'POST', url: cliUrl, headers: [keyValue(headerName, token)], body: { type: 'json', content: JSON.stringify({ command: 'todo.list', input: {}, workspace: folder }) } }) },
        { caller, workspaceId: ws.id },
      );
    const agentRelay = await viaApiClient(CLI_TOKEN_HEADER, 'mcp');
    const agentRelayUpper = await viaApiClient(CLI_TOKEN_HEADER.toUpperCase(), 'mcp');
    const userRelay = await viaApiClient(CLI_TOKEN_HEADER, 'ui');
    const relayRefused = (r: Awaited<ReturnType<typeof viaApiClient>>) => !r.ok && r.error.code === 'INVALID_INPUT' && r.error.message.includes(CLI_TOKEN_HEADER);
    check(
      'cli: the API client never sends the command line token, so an agent cannot relay calls to the endpoint through api.request.send',
      relayRefused(agentRelay) && relayRefused(agentRelayUpper) && relayRefused(userRelay),
      { agent: agentRelay.ok || agentRelay.error, agentUpper: agentRelayUpper.ok || agentRelayUpper.error.code, user: userRelay.ok || userRelay.error.code },
    );

    // No app: exit 3, unless --headless=auto runs it in-process instead.
    const nowhere = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-cli-nowhere-'));
    const autoData = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-cli-auto-'));
    const unreachable = await quiver(['--user-data-dir', nowhere, '--json', 'todo.list', '--workspace', nowhere]);
    const auto = await quiver(['--user-data-dir', nowhere, '--headless=auto', '--data-dir', autoData, '--json', 'tools.uuid.generate']);
    check(
      'cli: with no app to reach it exits 3, and --headless=auto runs in-process instead',
      unreachable.code === CLI_EXIT.unreachable && unreachable.stderr.includes('not running') && auto.code === 0 && auto.stdout.length > 0,
      { unreachable: [unreachable.code, unreachable.stderr], auto: [auto.code, auto.stdout.slice(0, 80), auto.stderr] },
    );

    // ---------- headless mode ----------

    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-cli-project-'));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-cli-data-'));
    const headless = (args: string[], env?: Record<string, string>) => quiver(['--headless', '--data-dir', data, '--workspace', project, '--json', ...args], env);
    try {
      const ciTodo = await headless(['todo.add', '--title', 'from CI']);
      const ciList = await headless(['todo.list']);
      const onDisk = json<TodoItem[]>(await fs.readFile(path.join(project, '.quiver', 'local', 'todos.json'), 'utf8').catch(() => '')) ?? [];
      const dataFiles = await fs.readdir(data);
      check(
        'cli: headless adds and lists a todo in a temporary workspace, with no app and no server of its own',
        ciTodo.code === 0 && (json<TodoItem[]>(ciList.stdout) ?? []).some((i) => i.title === 'from CI') && onDisk.some((i) => i.title === 'from CI') && !dataFiles.includes(CLI_ENDPOINT_FILE) && !dataFiles.includes(CLI_TOKEN_FILE),
        { add: [ciTodo.code, ciTodo.stderr], list: ciList.stdout.slice(0, 200), dataFiles },
      );

      // A project as CI checks it out: an environment whose secret is empty in the committed file, and two collections.
      const environment: Environment = {
        ...newEnvironment('ci'),
        variables: [
          { id: 'b', key: 'baseUrl', value: `http://127.0.0.1:${fixtures.echoPort}`, enabled: true },
          { id: 's', key: 'token', value: '', enabled: true, secret: true },
        ],
      };
      const passing = newCollection('CI passing');
      const mixed = newCollection('CI mixed');
      const authorized = (collectionId: string, name: string) =>
        newApiRequest({
          name,
          collectionId,
          url: '{{baseUrl}}/anything',
          headers: [keyValue('Authorization', 'Bearer {{token}}')],
          checks: [check200('c1'), { id: 'c2', enabled: true, on: 'jsonPath', path: '$.headers.authorization', op: 'eq', expected: 'Bearer {{token}}' }],
        });
      const write = async (collection: string, item: { id: string }) => {
        await fs.mkdir(path.join(project, '.quiver', collection), { recursive: true });
        await fs.writeFile(path.join(project, '.quiver', collection, `${item.id}.json`), JSON.stringify(item, null, 2));
      };
      await write('environments', environment);
      await write('collections', passing);
      await write('collections', mixed);
      await write('requests', authorized(passing.id, 'Authorized'));
      await write('requests', authorized(mixed.id, 'Authorized'));
      await write('requests', newApiRequest({ name: 'Expects 201', collectionId: mixed.id, url: '{{baseUrl}}/anything', checks: [check200('c3', '201')] }));

      const tokenOf = (r: CliRun) => json<Environment>(r.stdout)?.variables.find((v) => v.key === 'token')?.value;
      const fromEnv = await headless(['api.environment.get', '--id', environment.id], { QUIVER_SECRET_TOKEN: 'from-env' });
      const secretsFile = path.join(data, 'secrets.json');
      await fs.writeFile(secretsFile, JSON.stringify({ token: 'from-file' }));
      const fromFile = await headless(['api.environment.get', '--id', environment.id, '--secrets', secretsFile], { QUIVER_SECRET_TOKEN: 'from-env' });
      // A secret the app encrypted on this machine cannot be read headless: a clear error, unless the value is handed in.
      const secretsDoc = path.join(project, '.quiver', 'local', 'secrets.json');
      await fs.writeFile(secretsDoc, JSON.stringify({ [`${environment.id}/s`]: 'enc:c2VhbGVk' }));
      const sealed = await headless(['api.environment.get', '--id', environment.id]);
      const sealedError = json<{ code: string; message: string }>(sealed.stderr);
      const handedIn = await headless(['api.environment.get', '--id', environment.id], { QUIVER_SECRET_TOKEN: 'from-env' });
      check(
        'cli: headless reads a secret from QUIVER_SECRET_<NAME> or --secrets, and refuses one only the app can decrypt with SECRET_UNAVAILABLE',
        tokenOf(fromEnv) === 'from-env' && tokenOf(fromFile) === 'from-file' && sealed.code === CLI_EXIT.failed && sealedError?.code === 'SECRET_UNAVAILABLE' && sealedError.message.includes('QUIVER_SECRET_TOKEN') && tokenOf(handedIn) === 'from-env',
        { fromEnv: tokenOf(fromEnv), fromFile: tokenOf(fromFile), sealed: [sealed.code, sealedError], handedIn: tokenOf(handedIn), stderr: fromEnv.stderr },
      );
      await fs.rm(secretsDoc, { force: true });

      // A cookie jar the app encrypted is neither read nor replaced headless: the run keeps its cookies in memory.
      const jarFile = path.join(project, '.quiver', 'local', 'cookies.json');
      const sealedJar = JSON.stringify({ cipher: 'enc:YXBwLWNvb2tpZXM=' });
      await fs.writeFile(jarFile, sealedJar);
      const cookieSet = await headless(['api.cookie.set', '--url', 'http://ci.example/', '--cookie', 'ci=1']);
      const jarAfter = await fs.readFile(jarFile, 'utf8').catch(() => '');
      check(
        'cli: headless leaves a cookie jar the app encrypted in place rather than writing over it',
        cookieSet.code === 0 && jarAfter === sealedJar,
        { code: cookieSet.code, stderr: cookieSet.stderr, jarAfter },
      );
      await fs.rm(jarFile, { force: true });

      // The CI test runner: a collection run followed to its end, a JUnit report, exit 4 when a check failed.
      const report = path.join(project, 'results.xml');
      const mixedRun = await headless(['api.collection.run', '--collection', mixed.id, '--environment', environment.id, '--reporter', 'junit', '--out', report], { QUIVER_SECRET_TOKEN: 'from-env' });
      const finished = json<ApiRun>(mixedRun.stdout);
      const xml = await fs.readFile(report, 'utf8').catch(() => '');
      const passRun = await headless(['api.collection.run', '--collection', passing.id, '--environment', environment.id], { QUIVER_SECRET_TOKEN: 'from-env' });
      const passed = json<ApiRun>(passRun.stdout);
      const junitStdout = await headless(['api.collection.run', '--collection', passing.id, '--environment', environment.id, '--reporter', 'junit'], { QUIVER_SECRET_TOKEN: 'from-env' });
      check(
        'cli: api.collection.run waits for the run, writes JUnit, and exits 4 on a failed check and 0 when all pass',
        mixedRun.code === CLI_EXIT.checksFailed &&
          finished?.status === 'failed' &&
          finished.passed === 1 &&
          finished.failed === 1 &&
          xml.includes('<testsuite name="CI mixed" tests="2" failures="1" errors="0" skipped="0"') &&
          xml.includes('<testcase name="Authorized"') &&
          /<failure type="check" message="Expected [^"]*201[^"]*200">/.test(xml) &&
          passRun.code === 0 &&
          passed?.status === 'passed' &&
          junitStdout.code === 0 &&
          junitStdout.stdout.startsWith('<?xml') &&
          junitStdout.stdout.includes('tests="1" failures="0"'),
        { mixed: [mixedRun.code, finished?.status, finished?.items.map((i) => `${i.name}:${i.status}:${i.checks?.map((c) => c.message).join('|')}`), mixedRun.stderr], xml: xml.slice(0, 300), pass: [passRun.code, passed?.status, passRun.stderr], junit: junitStdout.stdout.slice(0, 120) },
      );

      // A secret handed in is used, never written down: nothing under .quiver/local holds it after the runs (the
      // echo's answer carried it, and the history keeps responses with the known secrets scrubbed).
      const local = path.join(project, '.quiver', 'local');
      const leaked: string[] = [];
      for (const name of await fs.readdir(local)) {
        const text = await fs.readFile(path.join(local, name), 'utf8').catch(() => '');
        const at = text.indexOf('from-env');
        if (at !== -1) leaked.push(`${name}: ${text.slice(Math.max(0, at - 300), at + 40)}`);
      }
      check('cli: a secret from the environment is never written to the project', leaked.length === 0, leaked);
    } finally {
      for (const dir of [project, data, nowhere, autoData]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    return {
      ui: async (u) => {
        const { js, wait, shot } = u;
        // Settings → Command line: connected mode is ready on this run's port, and a dev build offers npm run cli.
        // Opens Settings (or brings its tab back to the front) until the section is on screen, scrolled into view.
        const showSection = async () => {
          for (let i = 0; i < 6; i++) {
            const shown = await js(
              `(() => { const el = [...document.querySelectorAll('[data-testid=settings-cli]')].find((e) => e.offsetParent !== null); if (el) { el.closest('section')?.scrollIntoView(); return true; } const tab = [...document.querySelectorAll('[data-testid=tab]')].find((t) => t.getAttribute('data-title') === 'Settings'); if (tab) tab.click(); else window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); return false; })()`,
            );
            if (shown) return;
            await wait(400);
          }
        };
        await showSection();
        const panel = (await js(
          `(() => { const el = [...document.querySelectorAll('[data-testid=settings-cli]')].find((e) => e.offsetParent !== null); if (!el) return null; el.closest('section')?.scrollIntoView(); return { status: el.querySelector('[data-testid=cli-status]')?.textContent.trim() ?? null, connected: el.querySelector('[data-testid=cli-status]')?.getAttribute('data-connected'), dev: el.querySelector('[data-testid=cli-dev-command]')?.textContent.trim() ?? null, heading: el.closest('section')?.querySelector('h2')?.textContent.trim() }; })()`,
        )) as { status: string | null; connected: string | null; dev: string | null; heading: string } | null;
        check(
          'ui: settings has a Command line section that says connected mode is ready on the port, and how to run it from a checkout',
          panel !== null && panel.heading === 'Command line' && panel.connected === 'true' && String(panel.status).includes(`127.0.0.1:${t.mcpPort}/cli`) && panel.dev === 'npm run cli -- list',
          panel,
        );
        await showSection();
        await wait(200);
        await shot('40a-settings-cli-light');
        await js(`document.documentElement.classList.add('dark')`);
        await showSection();
        await wait(200);
        await shot('40b-settings-cli-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`(() => { const tab = document.querySelector('[data-testid=tab][aria-selected=true] [aria-label="Close tab"]'); if (tab) tab.click(); })()`);
        await wait(300);
      },
    };
  },
});
