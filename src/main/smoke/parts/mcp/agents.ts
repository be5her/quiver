import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_TIMEOUT_MS, REDACTED } from '@quiver/core';
import type { AgentActivityEntry, AgentPermissionRule, ApprovalGrant, GlobalConfig, HostEventName, PendingApproval, TodoItem } from '@quiver/core';
import { GlobalStore } from '@quiver/core/node';
import { until, type SmokeSection } from '../../part';

interface CallResult {
  isError: boolean;
  value: unknown;
  /** The refusal's `details.reason`, when the call was refused. */
  reason?: string;
}

/**
 * Agent permissions on Quiver's own MCP server: the mode and its migration from `allowMutating`, rules (global and per
 * workspace), approvals with each answer and a timeout, pause, and the activity feed; with --shots the approval dialog,
 * the status bar item and the Agent activity tab.
 */
const agents: SmokeSection = async (t) => {
  const { host, check, run, ws, folder, mcpPort, agentRpc } = t;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
  const initial = structuredClone(host.config.get().mcp);

  /** A session id for an agent of this name, from the MCP handshake. */
  const session = async (name: string) => ({ 'mcp-session-id': (await agentRpc({}, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } })) ?? '' });
  const call = async (headers: Record<string, string>, name: string, args: unknown, signal?: AbortSignal): Promise<CallResult> => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } };
    const text = body.result?.content?.[0]?.text ?? 'null';
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain text.
    }
    return { isError: body.result?.isError === true, value, reason: (value as { details?: { reason?: string } } | null)?.details?.reason };
  };
  const listTools = async (headers: Record<string, string> = {}) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    return ((await res.json()) as { result?: { tools?: { name: string; description?: string }[] } }).result?.tools ?? [];
  };
  const setMcp = (patch: Partial<GlobalConfig['mcp']>) => run('config.update', { patch: { mcp: { ...host.config.get().mcp, ...patch } } }, null);
  const setRules = (rules: AgentPermissionRule[], mode = host.config.get().mcp.permissions.mode) => setMcp({ permissions: { mode, rules } });
  const pending = () => run<PendingApproval[]>('mcp.approval.list', {}, null);
  const nextPending = async (commandId: string): Promise<PendingApproval | undefined> => {
    let found: PendingApproval | undefined;
    await until(async () => Boolean((found = (await pending()).find((p) => p.commandId === commandId))), 4000);
    return found;
  };
  /** Todos this section adds to the shared smoke workspace, removed again at the end so the todo part finds only its own. */
  const added: string[] = [];
  const addTodo = async (title: string) => {
    const item = await run<TodoItem>('todo.add', { title }, ws.id);
    added.push(item.id);
    return item;
  };
  const removeAdded = async () => {
    const left = new Set((await run<TodoItem[]>('todo.list', {}, ws.id)).map((i) => i.id));
    for (const id of added.splice(0)) if (left.has(id)) await run('todo.remove', { id }, ws.id).catch(() => {});
  };
  const todoExists = async (id: string) => (await run<TodoItem[]>('todo.list', {}, ws.id)).some((i) => i.id === id);
  // Watch what the host broadcasts, to see the approval event go out.
  const emitted: { event: HostEventName; payload: unknown }[] = [];
  const emit = host.emit.bind(host);
  host.emit = ((event, payload) => {
    emitted.push({ event, payload });
    emit(event, payload);
  }) as typeof host.emit;

  try {
    // ---------- the mode, and migration from allowMutating ----------
    check('agents: read-only is the default mode', initial.permissions.mode === 'read-only' && initial.permissions.rules.length === 0 && initial.paused === false && initial.allowMutating === false, initial);
    await run('config.update', { patch: { mcp: { ...host.config.get().mcp, allowMutating: true } } }, null);
    const flipped = host.config.get().mcp;
    await run('config.update', { patch: { mcp: { ...initial } } }, null);
    const back = host.config.get().mcp;
    check('agents: setting allowMutating alone, as older code does, switches the mode to allow and back', flipped.permissions.mode === 'allow' && back.permissions.mode === 'read-only' && back.allowMutating === false, {
      flipped: flipped.permissions.mode,
      back: back.permissions.mode,
    });
    const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiver-smoke-oldconfig-'));
    const oldFile = path.join(oldDir, 'config.json');
    await fs.writeFile(oldFile, JSON.stringify({ mcp: { enabled: true, port: 7411, allowMutating: true } }), 'utf8');
    const migrated = (await new GlobalStore(oldFile).load()).mcp;
    await fs.writeFile(oldFile, JSON.stringify({ mcp: { enabled: true, port: 7411, allowMutating: false } }), 'utf8');
    const migratedOff = (await new GlobalStore(oldFile).load()).mcp;
    await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
    check('agents: a config from before permissions keeps its meaning: allowMutating true is mode allow, false is read-only', migrated.permissions.mode === 'allow' && migratedOff.permissions.mode === 'read-only', {
      migrated: migrated.permissions,
      migratedOff: migratedOff.permissions,
    });

    // ---------- the controls are not tools ----------
    const toolsBefore = await listTools();
    const names = toolsBefore.map((x) => x.name);
    check('agents: approvals, activity, pause and permissions are not tools for agents', !names.some((n) => /^mcp_(approval|activity|pause|permissions)/.test(n)), names.filter((n) => n.startsWith('mcp_')));
    check(
      'agents: tool descriptions say what the mode gives mutating calls',
      (toolsBefore.find((x) => x.name === 'todo_remove')?.description ?? '').includes('refused until the user allows it') &&
        (toolsBefore.find((x) => x.name === 'db_query_run')?.description ?? '').includes('Read-only calls always work'),
    );

    // ---------- a deny rule hides the tool ----------
    await setRules([{ match: 'tools.uuid.generate', action: 'deny' }]);
    const denied = await listTools();
    const deniedCall = await call({}, 'tools_uuid_generate', {});
    const deniedInvoke = await host.invoke('tools.uuid.generate', {}, { caller: 'mcp', workspaceId: ws.id });
    check(
      'agents: a deny rule hides the tool from tools/list, so a call finds no such tool, and the registry refuses the command itself',
      !denied.some((x) => x.name === 'tools_uuid_generate') &&
        denied.some((x) => x.name === 'tools_base64_encode') &&
        deniedCall.isError &&
        String(deniedCall.value).includes('not found') &&
        !deniedInvoke.ok &&
        (deniedInvoke.error.details as { reason?: string }).reason === 'rule',
      { deniedCall, deniedInvoke },
    );
    await setRules([]);
    check('agents: removing the rule brings the tool back', (await listTools()).some((x) => x.name === 'tools_uuid_generate'));

    // ---------- ask, then allow once ----------
    await setMcp({ permissions: { mode: 'ask', rules: [] } });
    check('agents: in ask mode a mutating tool says it asks first', ((await listTools()).find((x) => x.name === 'todo_remove')?.description ?? '').includes('asks the user first'));
    const approver = await session('smoke-approver');
    const once = await addTodo('agent approval once');
    const onceCall = call(approver, 'todo_remove', { id: once.id });
    const oncePending = await nextPending('todo.remove');
    check(
      'agents: an asked call waits, naming the agent, the tool, the workspace and the arguments',
      Boolean(oncePending) &&
        oncePending!.agent.name === 'smoke-approver' &&
        oncePending!.title === 'Remove todo' &&
        oncePending!.mutating === true &&
        oncePending!.workspace?.id === ws.id &&
        (oncePending!.input as { id?: string }).id === once.id &&
        (await todoExists(once.id)),
      oncePending,
    );
    check(
      'agents: the host announces the approval to the window',
      emitted.some((e) => e.event === 'mcp.approval.requested' && (e.payload as PendingApproval).id === oncePending?.id) && emitted.some((e) => e.event === 'mcp.activity'),
    );
    const agentAnswer = await host.invoke('mcp.approval.respond', { id: oncePending?.id, choice: 'once' }, { caller: 'mcp', workspaceId: null });
    check('agents: only the window answers an approval', !agentAnswer.ok && (await pending()).length === 1, agentAnswer.ok ? 'answered?' : agentAnswer.error.message);
    await run('mcp.approval.respond', { id: oncePending!.id, choice: 'once' }, null);
    const onceResult = await onceCall;
    check('agents: allow once runs the call', !onceResult.isError && (onceResult.value as { removed?: boolean }).removed === true && !(await todoExists(once.id)) && (await pending()).length === 0, onceResult);
    const again = await addTodo('agent approval asks again');
    const againCall = call(approver, 'todo_remove', { id: again.id });
    const againPending = await nextPending('todo.remove');
    check('agents: allow once is for that call only: the next one asks again', Boolean(againPending));

    // ---------- ask, then deny ----------
    await run('mcp.approval.respond', { id: againPending!.id, choice: 'deny' }, null);
    const deniedResult = await againCall;
    check(
      'agents: a denied call is refused with reason denied and changes nothing',
      deniedResult.isError && (deniedResult.value as { code?: string }).code === 'MUTATION_BLOCKED' && deniedResult.reason === 'denied' && (await todoExists(again.id)),
      deniedResult,
    );

    // ---------- the arguments are masked ----------
    await setRules([{ match: 'tools.jwt.verify', action: 'ask' }]);
    const jwtCall = call(approver, 'tools_jwt_verify', { token: 'eyJhbGciOiJIUzI1NiJ9.e30.sig', key: 'super-secret-key' });
    const jwtPending = await nextPending('tools.jwt.verify');
    const jwtInput = (jwtPending?.input ?? {}) as { token?: string; key?: string };
    check('agents: a rule can ask about a read-only tool, and the arguments it shows have credentials masked', jwtPending?.mutating === false && jwtInput.token === REDACTED && jwtInput.key === REDACTED, jwtInput);
    if (jwtPending) await run('mcp.approval.respond', { id: jwtPending.id, choice: 'deny' }, null);
    await jwtCall;
    await setRules([]);

    // ---------- ask, then allow for the session ----------
    const other = await session('smoke-other');
    const sessionCall = call(approver, 'todo_remove', { id: again.id });
    const sessionPending = await nextPending('todo.remove');
    await run('mcp.approval.respond', { id: sessionPending!.id, choice: 'session' }, null);
    const sessionResult = await sessionCall;
    const third = await addTodo('agent approval session');
    const grantedResult = await call(approver, 'todo_remove', { id: third.id });
    const grants = (await run<{ grants: ApprovalGrant[] }>('mcp.activity.list', {}, null)).grants;
    check(
      'agents: allowed until restart lets the same agent call the tool again without asking',
      !sessionResult.isError && !grantedResult.isError && !(await todoExists(third.id)) && grants.some((g) => g.agent === 'smoke-approver' && g.commandId === 'todo.remove'),
      { sessionResult, grantedResult, grants },
    );
    const fourth = await addTodo('agent approval other agent');
    const otherCall = call(other, 'todo_remove', { id: fourth.id });
    const otherPending = await nextPending('todo.remove');
    check('agents: another agent is still asked', otherPending?.agent.name === 'smoke-other', otherPending?.agent);
    if (otherPending) await run('mcp.approval.respond', { id: otherPending.id, choice: 'deny' }, null);
    await otherCall;
    await run('mcp.approval.clearGrants', {}, null);

    // ---------- ask, then always allow ----------
    const alwaysCall = call(other, 'todo_remove', { id: fourth.id });
    const alwaysPending = await nextPending('todo.remove');
    await run('mcp.approval.respond', { id: alwaysPending!.id, choice: 'always' }, null);
    const alwaysResult = await alwaysCall;
    const rules = host.config.get().mcp.permissions.rules;
    const fifth = await addTodo('agent approval always');
    const afterAlways = await call(await session('smoke-third'), 'todo_remove', { id: fifth.id });
    check(
      'agents: always allow writes a rule, and later calls by any agent go through without asking',
      !alwaysResult.isError && rules.some((r) => r.match === 'todo.remove' && r.action === 'allow') && !afterAlways.isError && !(await todoExists(fifth.id)),
      { rules, afterAlways },
    );
    await setRules([]);

    // ---------- an approval nobody answers ----------
    host.approvals.timeoutMs = 400;
    const sixth = await addTodo('agent approval timeout');
    const timedOut = await call(approver, 'todo_remove', { id: sixth.id });
    host.approvals.timeoutMs = APPROVAL_TIMEOUT_MS;
    check('agents: a call nobody answers is refused with reason approval-timeout', timedOut.isError && timedOut.reason === 'approval-timeout' && (await pending()).length === 0 && (await todoExists(sixth.id)), timedOut);

    // ---------- an approval whose agent went away ----------
    const gone = new AbortController();
    const goneCall = call(approver, 'todo_remove', { id: sixth.id }, gone.signal).catch(() => null);
    const gonePending = await nextPending('todo.remove');
    gone.abort();
    await goneCall;
    await until(async () => (await pending()).length === 0, 3000);
    const lateAnswer = gonePending ? await host.invoke('mcp.approval.respond', { id: gonePending.id, choice: 'once' }, { caller: 'ui', workspaceId: null }) : null;
    const goneActivity = (await run<{ calls: AgentActivityEntry[] }>('mcp.activity.list', {}, null)).calls[0];
    check(
      'agents: a call whose agent closed the connection stops waiting, so a late Allow cannot run it',
      Boolean(gonePending) && (await pending()).length === 0 && lateAnswer?.ok === false && (await todoExists(sixth.id)) && goneActivity?.decision === 'cancelled',
      { lateAnswer, goneActivity },
    );

    // ---------- pause ----------
    const waitingCall = call(approver, 'todo_remove', { id: sixth.id });
    await nextPending('todo.remove');
    const agentPause = await host.invoke('mcp.pause', { paused: true }, { caller: 'mcp', workspaceId: null });
    check('agents: an agent cannot pause or resume itself', !agentPause.ok && !host.config.get().mcp.paused);
    await run('mcp.pause', { paused: true }, null);
    const pausedWaiting = await waitingCall;
    const pausedRead = await call(approver, 'tools_base64_encode', { text: 'hi' });
    const pausedTools = await listTools();
    check(
      'agents: pause refuses every call with reason paused, those waiting included, and keeps the tool list',
      host.config.get().mcp.paused && pausedRead.isError && pausedRead.reason === 'paused' && pausedWaiting.isError && pausedWaiting.reason === 'paused' && pausedTools.length === toolsBefore.length,
      { pausedRead, pausedWaiting: pausedWaiting.reason, tools: [pausedTools.length, toolsBefore.length] },
    );
    await run('mcp.pause', { paused: false }, null);
    check('agents: resuming lets calls through again', !(await call(approver, 'tools_base64_encode', { text: 'hi' })).isError);

    // ---------- workspace rules come before global ones ----------
    await setMcp({ permissions: { mode: 'read-only', rules: [{ match: 'todo.*', action: 'ask' }, { match: 'tools.base64.encode', action: 'allow' }] } });
    const badRule = await host.invoke('mcp.permissions.setWorkspace', { rules: [{ match: 'not a match', action: 'allow' }] }, { caller: 'ui', workspaceId: ws.id });
    check('agents: a workspace rule with an invalid match is refused', !badRule.ok && badRule.error.code === 'INVALID_INPUT');
    await run('mcp.permissions.setWorkspace', { rules: [{ match: 'todo.list', action: 'allow' }, { match: 'tools.*', action: 'deny' }] }, ws.id);
    const stored = host.config.get().mcp.workspaceRules[ws.id] ?? [];
    const listed = await call(approver, 'todo_list', {});
    const noAsk = (await pending()).length === 0;
    const wsDenied = await host.invoke('tools.base64.encode', { text: 'hi' }, { caller: 'mcp', workspaceId: ws.id });
    const wsTools = await listTools();
    check(
      'agents: a workspace rule beats a global one: an allow over a global ask, a deny over a global allow (and hides the tool)',
      stored.length === 2 &&
        !listed.isError &&
        noAsk &&
        !wsDenied.ok &&
        (wsDenied.error.details as { reason?: string; level?: string }).level === 'workspace' &&
        !wsTools.some((x) => x.name === 'tools_base64_encode'),
      { listed: listed.isError, noAsk, wsDenied, stored },
    );
    const agentRules = await host.invoke('mcp.permissions.setWorkspace', { rules: [] }, { caller: 'mcp', workspaceId: ws.id });
    check('agents: an agent cannot change the workspace rules', !agentRules.ok && (await run<{ rules: AgentPermissionRule[] }>('mcp.permissions.workspace', {}, ws.id)).rules.length === 2);

    // Always allow, when a workspace rule asked: the allow goes into the workspace rules, where it beats that rule.
    await run('mcp.permissions.setWorkspace', { rules: [{ match: 'todo.*', action: 'ask' }] }, ws.id);
    await setMcp({ permissions: { mode: 'allow', rules: [] } });
    const wsAlwaysTodo = await addTodo('agent approval always in the workspace');
    const wsAlwaysCall = call(approver, 'todo_remove', { id: wsAlwaysTodo.id });
    const wsAlwaysPending = await nextPending('todo.remove');
    const wsAlwaysAnswer = wsAlwaysPending ? await run<{ level?: string }>('mcp.approval.respond', { id: wsAlwaysPending.id, choice: 'always' }, null) : null;
    await wsAlwaysCall;
    const wsAfterTodo = await addTodo('agent approval after always in the workspace');
    const wsAfter = await call(approver, 'todo_remove', { id: wsAfterTodo.id });
    check(
      'agents: always allow after a workspace rule asked writes the allow into the workspace rules, and the next call does not ask',
      wsAlwaysAnswer?.level === 'workspace' &&
        (host.config.get().mcp.workspaceRules[ws.id] ?? []).some((r) => r.match === 'todo.remove' && r.action === 'allow') &&
        !host.config.get().mcp.permissions.rules.some((r) => r.match === 'todo.remove') &&
        !wsAfter.isError &&
        !(await todoExists(wsAfterTodo.id)),
      { wsAlwaysAnswer, workspaceRules: host.config.get().mcp.workspaceRules[ws.id], wsAfter },
    );
    await run('mcp.permissions.setWorkspace', { rules: [] }, ws.id);
    await setMcp({ permissions: { mode: 'read-only', rules: [] } });

    // A rules file in the project, as a repository could ship one, is not read: only rules made on this machine count.
    const planted = path.join(folder, '.quiver', 'local', 'agent-permissions.json');
    await fs.mkdir(path.dirname(planted), { recursive: true });
    await fs.writeFile(planted, JSON.stringify({ rules: [{ match: '*', action: 'allow' }] }), 'utf8');
    const plantedCall = await call(approver, 'todo_remove', { id: sixth.id });
    await fs.rm(planted, { force: true });
    check('agents: a rules file planted in the project allows nothing', plantedCall.isError && plantedCall.reason === 'read-only' && (await todoExists(sixth.id)), plantedCall);

    const readOnly = await call(approver, 'todo_remove', { id: sixth.id });
    check('agents: back in read-only mode a mutating call is refused at once with reason read-only', readOnly.isError && readOnly.reason === 'read-only' && (await pending()).length === 0, readOnly);

    // ---------- the activity feed ----------
    const activity = await run<{ calls: AgentActivityEntry[]; pending: PendingApproval[] }>('mcp.activity.list', {}, null);
    const mine = activity.calls.filter((c) => c.agent.name.startsWith('smoke-'));
    const decisions = new Set(mine.map((c) => c.decision));
    check(
      'agents: the activity feed lists the calls newest first with the agent, tool, workspace and decision, and no arguments',
      mine.length >= 10 &&
        ['approved', 'denied', 'approval-timeout', 'paused', 'refused', 'allowed', 'cancelled'].every((d) => decisions.has(d as AgentActivityEntry['decision'])) &&
        mine.every((c) => !('arguments' in c) && !('result' in c)) &&
        mine.some((c) => c.tool === 'todo.remove' && c.workspace?.name === ws.name && c.ok) &&
        Date.parse(activity.calls[0].at) >= Date.parse(activity.calls[activity.calls.length - 1].at),
      { count: mine.length, decisions: [...decisions] },
    );
  } finally {
    host.approvals.timeoutMs = APPROVAL_TIMEOUT_MS;
    host.approvals.clearGrants();
    host.emit = emit;
    await run('mcp.permissions.setWorkspace', { rules: [] }, ws.id).catch(() => {});
    await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: initial.permissions, paused: false, allowMutating: initial.allowMutating } } }, null);
    await removeAdded();
  }

  return {
    ui: async (u) => {
      const { js, wait, shot } = u;
      const approval = () =>
        js(
          `(() => { const d = document.querySelector('[data-testid=agent-approval]'); if (!d) return null; const q = (id) => d.querySelector('[data-testid=' + id + ']')?.textContent.trim() ?? ''; return { tool: d.getAttribute('data-tool'), agent: q('agent-approval-agent'), toolText: q('agent-approval-tool'), input: q('agent-approval-input'), queue: q('agent-approval-queue'), text: d.textContent, focused: document.activeElement === d }; })()`,
        ) as Promise<{ tool: string; agent: string; toolText: string; input: string; queue: string; text: string; focused: boolean } | null>;
      const statusItem = () =>
        js(`(() => { const b = document.querySelector('[data-testid=agent-activity-status]'); return b ? { pending: b.getAttribute('data-pending'), calls: Number(b.getAttribute('data-calls')), paused: b.getAttribute('data-paused'), text: b.textContent.trim() } : null; })()`) as Promise<{
          pending: string;
          calls: number;
          paused: string;
          text: string;
        } | null>;
      await setMcp({ permissions: { mode: 'ask', rules: [] } });
      try {
        // The dialog: an agent's call waits, one at a time, with the agent, the tool, the workspace and the arguments.
        const claude = await session('claude-code');
        const first = await addTodo('agent approval from the dialog');
        const second = await addTodo('agent approval queued');
        const firstCall = call(claude, 'todo_remove', { id: first.id });
        await nextPending('todo.remove');
        const secondCall = call(claude, 'todo_remove', { id: second.id });
        await until(async () => (await pending()).length === 2, 3000);
        await until(async () => Boolean((await approval())?.queue), 3000);
        const shown = await approval();
        const item = await statusItem();
        check(
          'ui: the approval dialog shows the agent, the tool, the workspace and the arguments, and how many more wait',
          shown?.tool === 'todo.remove' && shown.agent === 'claude-code' && shown.toolText === 'todo.remove' && shown.text.includes(ws.name) && shown.input.includes(first.id) && shown.queue === '1 more waiting',
          shown,
        );
        check('ui: the status bar shows the approvals waiting', item?.pending === '2' && item.text.includes('2 waiting'), item);
        check('ui: the dialog takes the focus itself, not a button, so a key typed for the page underneath answers nothing', shown?.focused === true, shown?.focused);
        // The config changes above make the theme follow the system again; the light shot wants light.
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);
        await shot('21e-mcp-agent-approval-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('21f-mcp-agent-approval-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('[data-testid=agent-approval-once]')?.click()`);
        const firstResult = await firstCall;
        await until(async () => (await approval())?.input.includes(second.id) ?? false, 3000);
        const next = await approval();
        check(
          'ui: Allow once runs the call and the dialog moves on to the next one, drawn afresh with the focus on the dialog',
          !firstResult.isError && !(await todoExists(first.id)) && Boolean(next?.input.includes(second.id)) && next?.queue === '' && next?.focused === true,
          { firstResult, next },
        );
        await js(`document.querySelector('[data-testid=agent-approval-deny]')?.click()`);
        const secondResult = await secondCall;
        await wait(400);
        check('ui: Deny refuses the call and closes the dialog', secondResult.isError && secondResult.reason === 'denied' && (await approval()) === null && (await todoExists(second.id)), secondResult);

        // The status bar item counts the calls of the last minute and opens the Agent activity tab.
        await call(claude, 'tools_base64_encode', { text: 'activity' });
        await wait(600);
        const counted = await statusItem();
        await js(`document.querySelector('[data-testid=agent-activity-status]')?.click()`);
        await wait(600);
        const rows = (await js(`[...document.querySelectorAll('[data-testid=agent-activity-row]')].slice(0, 4).map((r) => [r.getAttribute('data-agent'), r.getAttribute('data-tool'), r.getAttribute('data-decision')].join(':'))`)) as string[];
        check('ui: the status bar counts agent calls in the last minute', (counted?.calls ?? 0) >= 3 && counted?.pending === '0', counted);
        check(
          'ui: the status bar item opens the Agent activity tab, newest call first, with each decision',
          Array.isArray(rows) && rows[0] === 'claude-code:tools.base64.encode:allowed' && rows[1] === 'claude-code:todo.remove:denied' && rows[2] === 'claude-code:todo.remove:approved',
          rows,
        );
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);
        await shot('21g-mcp-agent-activity-light');

        // Pause from the status bar: the item says so, and calls are refused until resumed.
        await js(`document.querySelector('[data-testid=agent-pause-toggle]')?.click()`);
        await until(() => host.config.get().mcp.paused, 2000);
        await wait(300);
        const paused = await statusItem();
        const refused = await call(claude, 'tools_base64_encode', { text: 'paused' });
        const tabPause = await js(`document.querySelector('[data-testid=agent-activity-pause]')?.checked`);
        check('ui: the status bar pauses agents, and the item and the tab say so', paused?.paused === 'true' && paused.text.includes('Agents paused') && refused.reason === 'paused' && tabPause === true, { paused, tabPause });
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('21h-mcp-agent-activity-paused-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('[data-testid=agent-pause-toggle]')?.click()`);
        await until(() => !host.config.get().mcp.paused, 2000);
        check('ui: the status bar resumes agents', !host.config.get().mcp.paused);
      } finally {
        await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: initial.permissions, paused: false, allowMutating: initial.allowMutating } } }, null);
        for (const p of await pending()) await run('mcp.approval.respond', { id: p.id, choice: 'deny' }, null).catch(() => {});
        await removeAdded();
      }
    },
  };
};

export default agents;
