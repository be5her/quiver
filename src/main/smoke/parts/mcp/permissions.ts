import type { AgentActivityEntry, AgentPermissionRule, CommandActionsInfo, DbConnectionSummary, GlobalConfig, PendingApproval } from '@quiver/core';
import { until, type SmokeSection } from '../../part';

interface CallResult {
  isError: boolean;
  value: unknown;
  /** The refusal's details, when the call was refused. */
  details?: { reason?: string; action?: string; rule?: AgentPermissionRule; level?: string };
}

/**
 * Agent rules per action and per agent: `db.query.run#ddl` refusing a CREATE TABLE while a SELECT and an INSERT go
 * through, a rule for one agent by its name, the refusal naming the action and the rule, the action in the activity
 * feed, matches the save commands refuse, and `mcp.permissions.actions`; with --shots, Always allow for one action
 * from the approval dialog and the rules editor's Action and Agent columns. The kube action and git push rules are
 * checked in the teleport part and the git part, where their fixtures are.
 */
const permissions: SmokeSection = async (t) => {
  const { host, check, run, ws, folder, mcpPort, agentRpc } = t;
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp?workspace=${encodeURIComponent(folder)}`;
  const initial = structuredClone(host.config.get().mcp);

  /** A session id for an agent of this name, from the MCP handshake. */
  const session = async (name: string) => ({ 'mcp-session-id': (await agentRpc({}, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } })) ?? '' });
  const post = async (headers: Record<string, string>, method: string, params: unknown) => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
  };
  const call = async (headers: Record<string, string>, name: string, args: unknown): Promise<CallResult> => {
    const body = await post(headers, 'tools/call', { name, arguments: args });
    const text = body.result?.content?.[0]?.text ?? 'null';
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Plain text.
    }
    return { isError: body.result?.isError === true, value, details: (value as { details?: CallResult['details'] } | null)?.details };
  };
  const toolNames = async (headers: Record<string, string>) => ((await post(headers, 'tools/list', {})).result?.tools ?? []).map((x) => x.name);
  const setMcp = (patch: Partial<GlobalConfig['mcp']>) => run('config.update', { patch: { mcp: { ...host.config.get().mcp, ...patch } } }, null);
  const pending = () => run<PendingApproval[]>('mcp.approval.list', {}, null);
  const nextPending = async (commandId: string): Promise<PendingApproval | undefined> => {
    let found: PendingApproval | undefined;
    await until(async () => Boolean((found = (await pending()).find((p) => p.commandId === commandId))), 4000);
    return found;
  };

  // A SQLite database of this section's own, in the shared workspace.
  const db = await run<DbConnectionSummary>('db.connection.save', { connection: { kind: 'sqlite', name: 'smoke agent rules', file: 'data/smoke-agent-rules.db' } }, ws.id);
  const sql = (query: string) => ({ connectionId: db.id, query, record: false });
  const tableCount = async () => {
    const [result] = await run<{ kind: string; rows?: unknown[][] }[]>('db.query.run', sql("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_rules%'"), ws.id);
    return Number(result?.rows?.[0]?.[0] ?? -1);
  };
  await run('db.query.run', sql('DROP TABLE IF EXISTS agent_rules_made; CREATE TABLE IF NOT EXISTS agent_rules (id INTEGER)'), ws.id);

  try {
    // ---------- the actions commands declare ----------
    const declared = await run<CommandActionsInfo[]>('mcp.permissions.actions', {}, null);
    const actionsOf = (id: string) => declared.find((d) => d.commandId === id)?.actions ?? [];
    check(
      'agent rules: mcp.permissions.actions lists the commands that declare actions, with their actions and a line about each',
      JSON.stringify(actionsOf('db.query.run')) === JSON.stringify(['select', 'insert', 'update', 'delete', 'ddl', 'other']) &&
        JSON.stringify(actionsOf('db.redis.command')) === JSON.stringify(['read', 'write', 'admin']) &&
        JSON.stringify(actionsOf('db.table.apply')) === JSON.stringify(['insert', 'update', 'delete', 'mixed']) &&
        actionsOf('teleport.kube.action').includes('scale-to-zero') &&
        actionsOf('teleport.kube.action').includes('delete') &&
        JSON.stringify(actionsOf('git.push')) === JSON.stringify(['push', 'force']) &&
        JSON.stringify(actionsOf('git.reset')) === JSON.stringify(['soft', 'mixed', 'hard']) &&
        JSON.stringify(actionsOf('git.branch.delete')) === JSON.stringify(['delete', 'force']) &&
        JSON.stringify(actionsOf('git.discard')) === JSON.stringify(['changes', 'untracked', 'both']) &&
        Boolean(declared.find((d) => d.commandId === 'db.query.run')?.describe.ddl),
      declared.map((d) => `${d.commandId}: ${d.actions.join(',')}`),
    );
    const names = await toolNames({});
    check('agent rules: mcp.permissions.actions is not a tool for agents', !names.includes('mcp_permissions_actions'));

    // ---------- a deny on one action of db.query.run ----------
    await setMcp({ permissions: { mode: 'allow', rules: [{ match: 'db.query.run#ddl', action: 'deny' }] } });
    const smoke = await session('smoke');
    const listed = await toolNames(smoke);
    const create = await call(smoke, 'db_query_run', sql('CREATE TABLE agent_rules_made (id INTEGER)'));
    const select = await call(smoke, 'db_query_run', sql('SELECT * FROM agent_rules'));
    const insert = await call(smoke, 'db_query_run', sql('INSERT INTO agent_rules VALUES (1)'));
    check(
      'agent rules: db.query.run#ddl deny with mode allow refuses a CREATE TABLE, naming the action and the rule, and lets a SELECT and an INSERT through',
      create.isError &&
        create.details?.reason === 'rule' &&
        create.details.action === 'ddl' &&
        create.details.rule?.match === 'db.query.run#ddl' &&
        (await tableCount()) === 1 &&
        !select.isError &&
        !insert.isError,
      { create, select: select.isError, insert: insert.isError },
    );
    check('agent rules: a deny on one action leaves the tool in tools/list', listed.includes('db_query_run'), listed.length);
    const feed = (await run<{ calls: AgentActivityEntry[] }>('mcp.activity.list', {}, null)).calls.filter((c) => c.agent.name === 'smoke' && c.tool === 'db.query.run').slice(0, 3);
    check(
      'agent rules: the activity feed names each call’s action',
      JSON.stringify(feed.map((c) => [c.action, c.decision])) === JSON.stringify([['insert', 'allowed'], ['select', 'allowed'], ['ddl', 'refused']]),
      feed.map((c) => [c.action, c.decision]),
    );

    // ---------- a rule for one agent ----------
    await setMcp({ permissions: { mode: 'allow', rules: [{ match: 'tools.base64.encode', action: 'deny', agent: 'smoke' }] } });
    const other = await session('smoke-rules-other');
    const mine = await call(smoke, 'tools_base64_encode', { text: 'hi' });
    const theirs = await call(other, 'tools_base64_encode', { text: 'hi' });
    const mineListed = await toolNames(smoke);
    const theirsListed = await toolNames(other);
    check(
      'agent rules: a rule with an agent applies to the client of that name only: refused and hidden for it, open to another',
      mine.isError &&
        String(mine.value).includes('not found') &&
        !theirs.isError &&
        !mineListed.includes('tools_base64_encode') &&
        theirsListed.includes('tools_base64_encode'),
      { mine: mine.value, theirs: theirs.isError },
    );
    // An agent whose name is not known (unknown) is not the agent the rule names either.
    const direct = await host.invoke('tools.base64.encode', { text: 'hi' }, { caller: 'mcp', workspaceId: ws.id });
    check(
      'agent rules: a call without an agent name is not matched by a rule for one agent',
      direct.ok,
      direct.ok ? 'ok' : direct.error,
    );

    // ---------- matches the save commands refuse ----------
    const refusedMatches: unknown[] = [];
    for (const match of ['git.*#force', '#x', 'a#', '*#push', 'db.query.run#drop', 'todo.add#x']) {
      const out = await host.invoke('mcp.permissions.setRule', { level: 'global', match, action: 'deny' }, { caller: 'ui', workspaceId: null });
      if (out.ok || out.error.code !== 'INVALID_INPUT') refusedMatches.push(match);
    }
    const badWorkspace = await host.invoke('mcp.permissions.setWorkspace', { rules: [{ match: 'git.push#forced', action: 'deny' }] }, { caller: 'ui', workspaceId: ws.id });
    const goodRule = await host.invoke('mcp.permissions.setRule', { level: 'global', match: 'git.push#force', action: 'deny', agent: 'smoke' }, { caller: 'ui', workspaceId: null });
    const grammar = await host.invoke('mcp.permissions.setRule', { level: 'global', match: 'git.*#force', action: 'deny' }, { caller: 'ui', workspaceId: null });
    check(
      'agent rules: the save commands refuse an action after a glob, an empty side of #, and an action the command does not declare; a valid one is saved with its agent',
      refusedMatches.length === 0 &&
        !badWorkspace.ok &&
        goodRule.ok &&
        host.config.get().mcp.permissions.rules.some((r) => r.match === 'git.push#force' && r.agent === 'smoke') &&
        !grammar.ok &&
        grammar.error.message.includes('db.query.run#ddl'),
      { refusedMatches, badWorkspace: badWorkspace.ok, grammar: grammar.ok ? 'ok?' : grammar.error.message },
    );
    await host.invoke('mcp.permissions.setRule', { level: 'global', match: 'git.push#force', action: null, agent: 'smoke' }, { caller: 'ui', workspaceId: null });
    check('agent rules: a rule for an agent is removed by its match and agent', !host.config.get().mcp.permissions.rules.some((r) => r.match === 'git.push#force'));
  } finally {
    await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: initial.permissions, paused: false, allowMutating: initial.allowMutating } } }, null);
  }

  const cleanup = async () => {
    await run('db.query.run', sql('DROP TABLE IF EXISTS agent_rules; DROP TABLE IF EXISTS agent_rules_made'), ws.id).catch(() => {});
    await run('db.connection.delete', { id: db.id }, ws.id).catch(() => {});
  };

  return {
    ui: async (u) => {
      const { js, wait, shot } = u;
      try {
        // ---------- the approval dialog names the action, and Always allow offers it ----------
        await setMcp({ permissions: { mode: 'ask', rules: [] } });
        const claude = await session('claude-code');
        const insertCall = call(claude, 'db_query_run', sql('INSERT INTO agent_rules VALUES (2)'));
        const asked = await nextPending('db.query.run');
        await until(async () => Boolean(await js(`document.querySelector('[data-testid=agent-approval-always-action]')?.disabled === false`)), 3000);
        const shown = (await js(
          `(() => { const d = document.querySelector('[data-testid=agent-approval]'); if (!d) return null; return { action: d.getAttribute('data-action'), actionText: d.querySelector('[data-testid=agent-approval-action]')?.textContent.trim(), always: d.querySelector('[data-testid=agent-approval-always-action]')?.textContent.trim(), tool: d.querySelector('[data-testid=agent-approval-always]')?.textContent.trim() }; })()`,
        )) as { action: string; actionText: string; always: string; tool: string } | null;
        check(
          'ui: the approval dialog shows the action beside the tool, and Always allow offers the action or the whole tool',
          asked?.action === 'insert' && shown?.action === 'insert' && shown.actionText === 'insert' && shown.always === 'Always allow insert' && shown.tool === 'Always allow tool',
          { asked: asked?.action, shown },
        );
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);
        await shot('21i-mcp-agent-approval-action-light');
        await js(`document.querySelector('[data-testid=agent-approval-always-action]')?.click()`);
        const inserted = await insertCall;
        await until(() => host.config.get().mcp.permissions.rules.some((r) => r.match === 'db.query.run#insert'), 3000);
        const afterInsert = await call(claude, 'db_query_run', sql('INSERT INTO agent_rules VALUES (3)'));
        const deleteCall = call(claude, 'db_query_run', sql('DELETE FROM agent_rules'));
        const deleteAsked = await nextPending('db.query.run');
        check(
          'ui: Always allow for the action writes a db.query.run#insert rule: the next INSERT goes through without asking, a DELETE still asks',
          !inserted.isError &&
            JSON.stringify(host.config.get().mcp.permissions.rules) === JSON.stringify([{ match: 'db.query.run#insert', action: 'allow' }]) &&
            !afterInsert.isError &&
            deleteAsked?.action === 'delete',
          { inserted: inserted.isError, rules: host.config.get().mcp.permissions.rules, afterInsert: afterInsert.isError, deleteAsked: deleteAsked?.action },
        );
        if (deleteAsked) await run('mcp.approval.respond', { id: deleteAsked.id, choice: 'deny' }, null);
        await deleteCall;

        // ---------- the rules editor's Action and Agent columns ----------
        await setMcp({ permissions: { mode: 'ask', rules: [{ match: 'git.push#force', action: 'deny' }, { match: 'teleport.kube.action#delete', action: 'ask', agent: 'claude-code' }] } });
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
        await wait(600);
        await js(`document.querySelector('[data-testid=settings-mcp]')?.scrollIntoView()`);
        const setField = (selector: string, value: string) =>
          js(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            if (el instanceof HTMLSelectElement) el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`);
        const editor = '[data-testid=mcp-rules-global]';
        await setField(`${editor} [data-testid=agent-rule-match]`, 'db.query.run');
        await wait(300);
        const picker = (await js(`(() => { const el = document.querySelector('${editor} [data-testid=agent-rule-tool-action]'); return el ? { tag: el.tagName, options: [...(el.options ?? [])].map((o) => o.value) } : null; })()`)) as { tag: string; options: string[] } | null;
        await setField(`${editor} [data-testid=agent-rule-tool-action]`, 'ddl');
        await setField(`${editor} [data-testid=agent-rule-agent]`, 'claude-code');
        await setField(`${editor} [data-testid=agent-rule-action]`, 'deny');
        await wait(200);
        const hint = (await js(`document.querySelector('${editor} [data-testid=agent-rule-hint]')?.textContent.trim()`)) as string | undefined;
        await js(`document.querySelector('${editor} [data-testid=agent-rule-add]')?.click()`);
        await until(() => host.config.get().mcp.permissions.rules.some((r) => r.match === 'db.query.run#ddl'), 2000);
        await wait(300);
        const rows = (await js(`[...document.querySelectorAll('${editor} [data-testid=agent-rule]')].map((r) => r.getAttribute('aria-label'))`)) as string[];
        check(
          'ui: the rules editor picks the action from the ones the tool declares, takes an agent, and saves db.query.run#ddl for claude-code',
          picker?.tag === 'SELECT' &&
            JSON.stringify(picker.options) === JSON.stringify(['', 'select', 'insert', 'update', 'delete', 'ddl', 'other']) &&
            Boolean(hint?.includes('the calls that ddl')) &&
            host.config.get().mcp.permissions.rules.some((r) => r.match === 'db.query.run#ddl' && r.action === 'deny' && r.agent === 'claude-code'),
          { picker, hint, rules: host.config.get().mcp.permissions.rules },
        );
        check(
          'ui: the rules read tool · action · agent · decision',
          JSON.stringify(rows) === JSON.stringify(['git.push · force · any agent · deny', 'teleport.kube.action · delete · claude-code · ask', 'db.query.run · ddl · claude-code · deny']),
          rows,
        );
        // A tool that declares no actions gets a free text field; a glob none.
        await setField(`${editor} [data-testid=agent-rule-match]`, 'todo.add');
        await wait(150);
        const free = (await js(`(() => { const el = document.querySelector('${editor} [data-testid=agent-rule-tool-action]'); return el ? { tag: el.tagName, disabled: el.disabled } : null; })()`)) as { tag: string; disabled: boolean } | null;
        await setField(`${editor} [data-testid=agent-rule-match]`, 'git.*#force');
        await wait(150);
        const globAction = (await js(`({ disabled: document.querySelector('${editor} [data-testid=agent-rule-add]')?.disabled, hint: document.querySelector('${editor} [data-testid=agent-rule-hint]')?.textContent.trim() })`)) as { disabled: boolean; hint: string };
        check(
          'ui: a tool without declared actions gets a free text action, and an action after a glob cannot be added, the hint naming the grammar',
          free?.tag === 'INPUT' && free.disabled === false && globAction.disabled === true && globAction.hint.includes('db.query.run#ddl'),
          { free, globAction },
        );
        await setField(`${editor} [data-testid=agent-rule-match]`, '');
        await wait(150);
        await js(`document.documentElement.classList.remove('dark')`);
        await wait(200);
        await js(`document.querySelector('[data-testid=settings-mcp]')?.scrollIntoView()`);
        await shot('27d-settings-agent-rules-actions-light');
        await js(`document.documentElement.classList.add('dark')`);
        await wait(300);
        await shot('27e-settings-agent-rules-actions-dark');
        await js(`document.documentElement.classList.remove('dark')`);
        await js(`document.querySelector('${editor} [data-testid=agent-rule][data-match="db.query.run#ddl"] button')?.click()`);
        await until(() => !host.config.get().mcp.permissions.rules.some((r) => r.match === 'db.query.run#ddl'), 2000);
        check('ui: the remove button deletes the rule for that agent', !host.config.get().mcp.permissions.rules.some((r) => r.match === 'db.query.run#ddl') && host.config.get().mcp.permissions.rules.length === 2);
      } finally {
        await run('config.update', { patch: { mcp: { ...host.config.get().mcp, permissions: initial.permissions, paused: false, allowMutating: initial.allowMutating } } }, null);
        for (const p of await pending()) await run('mcp.approval.respond', { id: p.id, choice: 'deny' }, null).catch(() => {});
        await cleanup();
      }
    },
    after: cleanup,
  };
};

export default permissions;
