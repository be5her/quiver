import { describe, expect, it } from 'vitest';
import { defaultGlobalConfig } from './defaults';
import {
  decideAgentPermission,
  isValidRuleMatch,
  migrateMcpConfig,
  normalizeRules,
  parseRuleMatch,
  removeRule,
  ruleAppliesToAgent,
  ruleMatchFor,
  ruleMatchesCommand,
  ruleSpecificity,
  sameRule,
  upsertRule,
  withWorkspaceRules,
  workspaceRulesFor,
  type AgentPermissionRule,
  type AgentPermissions,
} from './permissions';

const decide = (commandId: string, mutating: boolean, permissions: AgentPermissions, workspaceRules?: AgentPermissionRule[]) =>
  decideAgentPermission({ commandId, mutating, permissions, workspaceRules });

describe('decideAgentPermission', () => {
  const none = (mode: AgentPermissions['mode']): AgentPermissions => ({ mode, rules: [] });

  it('allows read-only calls and gives mutating ones the mode when no rule matches', () => {
    expect(decide('git.status', false, none('read-only'))).toEqual({ action: 'allow', source: 'default' });
    expect(decide('git.commit', true, none('read-only'))).toEqual({ action: 'deny', source: 'mode' });
    expect(decide('git.commit', true, none('ask'))).toEqual({ action: 'ask', source: 'mode' });
    expect(decide('git.commit', true, none('allow'))).toEqual({ action: 'allow', source: 'mode' });
  });

  it('lets a rule ask about or deny a read-only command', () => {
    expect(decide('db.query.run', false, { mode: 'allow', rules: [{ match: 'db.query.run', action: 'deny' }] })).toMatchObject({ action: 'deny', source: 'rule', level: 'global' });
    expect(decide('git.status', false, { mode: 'allow', rules: [{ match: 'git.*', action: 'ask' }] })).toMatchObject({ action: 'ask', source: 'rule' });
  });

  it('lets a rule allow a mutating command in read-only mode', () => {
    expect(decide('todo.remove', true, { mode: 'read-only', rules: [{ match: 'todo.remove', action: 'allow' }] })).toMatchObject({ action: 'allow', source: 'rule' });
  });

  it('prefers an exact id over a module glob over *', () => {
    const rules: AgentPermissionRule[] = [
      { match: '*', action: 'ask' },
      { match: 'git.*', action: 'allow' },
      { match: 'git.push', action: 'ask' },
    ];
    expect(decide('git.push', true, { mode: 'read-only', rules })).toMatchObject({ action: 'ask', rule: { match: 'git.push' } });
    expect(decide('git.commit', true, { mode: 'read-only', rules })).toMatchObject({ action: 'allow', rule: { match: 'git.*' } });
    expect(decide('db.query.run', true, { mode: 'read-only', rules })).toMatchObject({ action: 'ask', rule: { match: '*' } });
  });

  it('prefers the longer glob, and the stricter rule on a tie', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.*', action: 'allow' },
      { match: 'git.branch.*', action: 'ask' },
    ];
    expect(decide('git.branch.delete', true, { mode: 'allow', rules })).toMatchObject({ action: 'ask', rule: { match: 'git.branch.*' } });
    const tie: AgentPermissionRule[] = [
      { match: 'git.*', action: 'allow' },
      { match: 'git.*', action: 'ask' },
    ];
    expect(decide('git.commit', true, { mode: 'allow', rules: tie })).toMatchObject({ action: 'ask' });
  });

  it('lets deny beat everything, however specific the other rules are', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.*', action: 'deny' },
      { match: 'git.status', action: 'allow' },
    ];
    expect(decide('git.status', false, { mode: 'allow', rules })).toMatchObject({ action: 'deny', rule: { match: 'git.*' } });
    expect(decide('git.status', false, { mode: 'allow', rules: [{ match: '*', action: 'deny' }] }, [{ match: 'git.status', action: 'allow' }])).toMatchObject({ action: 'deny', level: 'global' });
  });

  it('lets workspace rules beat global ones', () => {
    const global: AgentPermissions = { mode: 'read-only', rules: [{ match: 'todo.remove', action: 'allow' }] };
    expect(decide('todo.remove', true, global, [{ match: 'todo.*', action: 'ask' }])).toMatchObject({ action: 'ask', level: 'workspace' });
    expect(decide('todo.remove', true, global, [{ match: 'todo.remove', action: 'deny' }])).toMatchObject({ action: 'deny', level: 'workspace' });
    expect(decide('todo.list', false, { mode: 'read-only', rules: [{ match: 'todo.*', action: 'ask' }] }, [{ match: 'todo.list', action: 'allow' }])).toMatchObject({ action: 'allow', level: 'workspace' });
    expect(decide('todo.remove', true, global, [{ match: 'git.*', action: 'ask' }])).toMatchObject({ action: 'allow', level: 'global' });
  });
});

describe('rule matches', () => {
  it('accepts ids, prefix globs and *', () => {
    for (const ok of ['*', 'git.*', 'git.branch.*', 'db.query.run', 'api_request-x.y']) expect(isValidRuleMatch(ok)).toBe(true);
    for (const bad of ['', 'git.', '.git', 'git*', 'git.*.x', '*.git', 'git status', 'git..x']) expect(isValidRuleMatch(bad)).toBe(false);
  });

  it('matches a glob on whole segments only', () => {
    expect(ruleSpecificity('git.*', 'git.status')).toBe(1);
    expect(ruleSpecificity('git.*', 'gitlab.status')).toBe(-1);
    expect(ruleSpecificity('*', 'anything')).toBe(0);
    expect(ruleSpecificity('git.status', 'git.status.more')).toBe(-1);
  });

  it('drops invalid rules from a hand-edited file and replaces a rule by its match', () => {
    expect(normalizeRules([{ match: ' git.* ', action: 'deny' }, { match: 'x', action: 'maybe' }, { match: 'bad match', action: 'allow' }, null, 'x'])).toEqual([{ match: 'git.*', action: 'deny' }]);
    expect(normalizeRules({})).toEqual([]);
    expect(upsertRule([{ match: 'a', action: 'ask' }], { match: 'a', action: 'allow' })).toEqual([{ match: 'a', action: 'allow' }]);
    expect(upsertRule([{ match: 'a', action: 'ask' }], { match: 'b', action: 'allow' })).toHaveLength(2);
  });
});

describe('workspace rules in the config', () => {
  it('reads and replaces one workspace’s rules, dropping a workspace left with none', () => {
    const rules: AgentPermissionRule[] = [{ match: 'git.*', action: 'allow' }];
    const mcp = { workspaceRules: { a: rules } };
    expect(workspaceRulesFor(mcp, 'a')).toEqual(rules);
    expect(workspaceRulesFor(mcp, 'b')).toEqual([]);
    expect(workspaceRulesFor(mcp, undefined)).toEqual([]);
    expect(withWorkspaceRules(mcp, 'b', rules)).toEqual({ a: rules, b: rules });
    expect(withWorkspaceRules(mcp, 'a', [])).toEqual({});
    expect(mcp.workspaceRules).toEqual({ a: rules });
  });

  it('keeps only the deny and ask rules for a global command', () => {
    const rules: AgentPermissionRule[] = [
      { match: '*', action: 'allow' },
      { match: 'teleport.*', action: 'ask' },
      { match: 'app.*', action: 'deny' },
    ];
    expect(workspaceRulesFor({ workspaceRules: { a: rules } }, 'a', 'global')).toEqual(rules.slice(1));
    expect(workspaceRulesFor({ workspaceRules: { a: rules } }, 'a', 'workspace')).toEqual(rules);
  });
});

describe('migrateMcpConfig', () => {
  const defaults = defaultGlobalConfig().mcp;

  it('turns an older allowMutating into the mode', () => {
    const { permissions: _p, ...older } = { ...defaults, allowMutating: true };
    expect(migrateMcpConfig({ ...defaults, ...older }, defaults).permissions.mode).toBe('allow');
    expect(migrateMcpConfig({ ...defaults, allowMutating: false }, defaults).permissions.mode).toBe('read-only');
  });

  it('keeps a stored mode and keeps allowMutating in step with it', () => {
    const ask = migrateMcpConfig({ ...defaults, permissions: { mode: 'ask', rules: [] } }, defaults);
    expect(ask).toMatchObject({ allowMutating: false, permissions: { mode: 'ask' } });
    const allow = migrateMcpConfig({ ...defaults, permissions: { mode: 'allow', rules: [] } }, defaults);
    expect(allow.allowMutating).toBe(true);
    // A full section sent back with a new mode and the old allowMutating keeps the new mode.
    expect(migrateMcpConfig({ ...allow, permissions: { mode: 'read-only', rules: [] } }, allow)).toMatchObject({ allowMutating: false, permissions: { mode: 'read-only' } });
  });

  it('lets a patch that only flips allowMutating switch the mode, and restores an ask mode after it', () => {
    const ask = migrateMcpConfig({ ...defaults, permissions: { mode: 'ask', rules: [{ match: 'git.*', action: 'deny' }] } }, defaults);
    const allowed = migrateMcpConfig({ ...ask, allowMutating: true }, ask);
    expect(allowed).toMatchObject({ allowMutating: true, permissions: { mode: 'allow', rules: [{ match: 'git.*', action: 'deny' }] } });
    expect(migrateMcpConfig({ ...ask }, allowed).permissions.mode).toBe('ask');
  });

  it('keeps the rules when a patch names only the mode, and the mode when it names only the rules', () => {
    const ask = migrateMcpConfig({ ...defaults, permissions: { mode: 'ask', rules: [{ match: 'git.*', action: 'deny' }] } }, defaults);
    const modeOnly = migrateMcpConfig({ ...ask, permissions: { mode: 'allow' } } as never, ask);
    expect(modeOnly.permissions).toEqual({ mode: 'allow', rules: [{ match: 'git.*', action: 'deny' }] });
    const rulesOnly = migrateMcpConfig({ ...ask, permissions: { rules: [] } } as never, ask);
    expect(rulesOnly.permissions).toEqual({ mode: 'ask', rules: [] });
  });

  it('falls back to read-only for an unknown mode and to false for paused', () => {
    const odd = migrateMcpConfig({ ...defaults, permissions: { mode: 'yolo', rules: 'x' }, paused: 'yes' } as never, defaults);
    expect(odd).toMatchObject({ allowMutating: false, paused: false, permissions: { mode: 'read-only', rules: [] } });
  });
});

describe('rules per action', () => {
  const decideCall = (rules: AgentPermissionRule[], options: { commandId?: string; mutating?: boolean; action?: string; agent?: string; mode?: AgentPermissions['mode']; workspaceRules?: AgentPermissionRule[] } = {}) =>
    decideAgentPermission({
      commandId: options.commandId ?? 'db.query.run',
      mutating: options.mutating ?? true,
      permissions: { mode: options.mode ?? 'allow', rules },
      workspaceRules: options.workspaceRules,
      action: options.action,
      agent: options.agent,
    });

  it('parses a match into its command part and its action', () => {
    expect(parseRuleMatch('db.query.run#ddl')).toEqual({ command: 'db.query.run', action: 'ddl' });
    expect(parseRuleMatch('git.*')).toEqual({ command: 'git.*' });
    expect(ruleMatchFor('git.push', 'force')).toBe('git.push#force');
    expect(ruleMatchFor('git.push')).toBe('git.push');
    expect(ruleMatchFor('git.push', null)).toBe('git.push');
  });

  it('accepts #<action> only after a full command id', () => {
    for (const ok of ['db.query.run#ddl', 'teleport.kube.action#scale-to-zero', 'git.push#force', 'x#a_1']) expect(isValidRuleMatch(ok)).toBe(true);
    for (const bad of ['git.*#force', '*#x', '#x', 'a#', 'a#b#c', 'a.#b', 'a#b c', 'a#b.c', 'a#*']) expect(isValidRuleMatch(bad)).toBe(false);
  });

  it('matches an action rule only for a call with that action', () => {
    expect(ruleSpecificity('db.query.run#ddl', 'db.query.run', 'ddl')).toBeGreaterThan(ruleSpecificity('db.query.run', 'db.query.run', 'ddl'));
    expect(ruleSpecificity('db.query.run', 'db.query.run', 'ddl')).toBeGreaterThan(ruleSpecificity('db.query.*', 'db.query.run', 'ddl'));
    expect(ruleSpecificity('db.query.run#ddl', 'db.query.run', 'select')).toBe(-1);
    expect(ruleSpecificity('db.query.run#ddl', 'db.query.run')).toBe(-1);
    expect(ruleSpecificity('db.query.run#ddl', 'db.query.cancel', 'ddl')).toBe(-1);
    expect(ruleMatchesCommand('db.query.run#ddl', 'db.query.run')).toBe(true);
    expect(ruleMatchesCommand('db.*', 'db.query.run')).toBe(true);
    expect(ruleMatchesCommand('*', 'db.query.run')).toBe(true);
    expect(ruleMatchesCommand('db.query.run#ddl', 'db.query.cancel')).toBe(false);
  });

  it('denies one action while the others get the mode or the command rule', () => {
    const rules: AgentPermissionRule[] = [{ match: 'db.query.run#ddl', action: 'deny' }];
    expect(decideCall(rules, { action: 'ddl' })).toMatchObject({ action: 'deny', source: 'rule', rule: { match: 'db.query.run#ddl' } });
    expect(decideCall(rules, { action: 'select', mutating: false })).toEqual({ action: 'allow', source: 'default' });
    expect(decideCall(rules, { action: 'insert' })).toEqual({ action: 'allow', source: 'mode' });
    expect(decideCall([...rules, { match: 'db.query.run', action: 'ask' }], { action: 'insert' })).toMatchObject({ action: 'ask', rule: { match: 'db.query.run' } });
  });

  it('prefers id#action over id over a glob over *', () => {
    const rules: AgentPermissionRule[] = [
      { match: '*', action: 'ask' },
      { match: 'teleport.*', action: 'allow' },
      { match: 'teleport.kube.action', action: 'ask' },
      { match: 'teleport.kube.action#scale', action: 'allow' },
    ];
    const kube = (action?: string) => decideCall(rules, { commandId: 'teleport.kube.action', action });
    expect(kube('scale')).toMatchObject({ action: 'allow', rule: { match: 'teleport.kube.action#scale' } });
    expect(kube('delete')).toMatchObject({ action: 'ask', rule: { match: 'teleport.kube.action' } });
    expect(kube()).toMatchObject({ action: 'ask', rule: { match: 'teleport.kube.action' } });
    expect(decideCall(rules, { commandId: 'teleport.login' })).toMatchObject({ action: 'allow', rule: { match: 'teleport.*' } });
    expect(decideCall(rules, { commandId: 'db.query.run', action: 'select' })).toMatchObject({ action: 'ask', rule: { match: '*' } });
  });

  it('applies only the command-level rules to a call whose action is unknown', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.push#force', action: 'deny' },
      { match: 'git.push#push', action: 'allow' },
    ];
    expect(decideCall(rules, { commandId: 'git.push', mode: 'ask' })).toEqual({ action: 'ask', source: 'mode' });
    expect(decideCall([...rules, { match: 'git.push', action: 'allow' }], { commandId: 'git.push', mode: 'ask' })).toMatchObject({ action: 'allow', rule: { match: 'git.push' } });
  });

  it('still lets any deny win: a deny on the command beats an allow on its action', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.push', action: 'deny' },
      { match: 'git.push#push', action: 'allow' },
    ];
    expect(decideCall(rules, { commandId: 'git.push', action: 'push' })).toMatchObject({ action: 'deny', rule: { match: 'git.push' } });
  });

  it('lets a workspace action rule beat a global one, and keeps the level of the deciding rule', () => {
    const decision = decideCall([{ match: 'db.query.run#insert', action: 'ask' }], { action: 'insert', workspaceRules: [{ match: 'db.query.run#insert', action: 'allow' }] });
    expect(decision).toMatchObject({ action: 'allow', level: 'workspace', rule: { match: 'db.query.run#insert' } });
  });
});

describe('rules per agent', () => {
  const decideFor = (rules: AgentPermissionRule[], agent: string | undefined, action?: string, mode: AgentPermissions['mode'] = 'ask') =>
    decideAgentPermission({ commandId: 'git.push', mutating: true, permissions: { mode, rules }, action, agent });

  it('applies a rule with an agent to that agent only', () => {
    const rules: AgentPermissionRule[] = [{ match: 'git.push', action: 'allow', agent: 'claude-code' }];
    expect(decideFor(rules, 'claude-code')).toMatchObject({ action: 'allow', rule: { agent: 'claude-code' } });
    expect(decideFor(rules, 'cursor')).toEqual({ action: 'ask', source: 'mode' });
    expect(decideFor(rules, undefined)).toEqual({ action: 'ask', source: 'mode' });
    expect(ruleAppliesToAgent({}, 'anyone')).toBe(true);
    expect(ruleAppliesToAgent({ agent: 'a' }, 'b')).toBe(false);
  });

  it('prefers the rule for the agent at equal specificity, whichever is stricter', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.push', action: 'ask' },
      { match: 'git.push', action: 'allow', agent: 'claude-code' },
    ];
    expect(decideFor(rules, 'claude-code')).toMatchObject({ action: 'allow', rule: { agent: 'claude-code' } });
    expect(decideFor(rules, 'cursor')).toMatchObject({ action: 'ask', rule: { match: 'git.push' } });
  });

  it('keeps specificity first: an action rule for every agent beats a command rule for this one', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.push', action: 'allow', agent: 'claude-code' },
      { match: 'git.push#force', action: 'ask' },
    ];
    expect(decideFor(rules, 'claude-code', 'force', 'allow')).toMatchObject({ action: 'ask', rule: { match: 'git.push#force' } });
    expect(decideFor(rules, 'claude-code', 'push', 'read-only')).toMatchObject({ action: 'allow' });
    expect(decideFor([{ match: 'git.*', action: 'allow', agent: 'claude-code' }, { match: 'git.push', action: 'ask' }], 'claude-code')).toMatchObject({ action: 'ask' });
  });

  it('lets a deny for one agent refuse that agent alone, even beside an allow', () => {
    const rules: AgentPermissionRule[] = [
      { match: 'git.push#force', action: 'deny', agent: 'cursor' },
      { match: 'git.push', action: 'allow' },
    ];
    expect(decideFor(rules, 'cursor', 'force')).toMatchObject({ action: 'deny', rule: { agent: 'cursor' } });
    expect(decideFor(rules, 'claude-code', 'force')).toMatchObject({ action: 'allow' });
  });

  it('keeps the agent through normalize, and tells rules apart by match and agent', () => {
    expect(normalizeRules([{ match: 'git.push#force', action: 'deny', agent: ' cursor ' }, { match: 'git.*', action: 'ask', agent: '  ' }, { match: 'a', action: 'allow', agent: 3 }, { match: 'git.*#x', action: 'deny' }])).toEqual([
      { match: 'git.push#force', action: 'deny', agent: 'cursor' },
      { match: 'git.*', action: 'ask' },
      { match: 'a', action: 'allow' },
    ]);
    const rules: AgentPermissionRule[] = [{ match: 'git.push', action: 'ask' }];
    const both = upsertRule(rules, { match: 'git.push', action: 'allow', agent: 'claude-code' });
    expect(both).toEqual([{ match: 'git.push', action: 'ask' }, { match: 'git.push', action: 'allow', agent: 'claude-code' }]);
    expect(upsertRule(both, { match: 'git.push', action: 'deny', agent: 'claude-code' })[1]).toEqual({ match: 'git.push', action: 'deny', agent: 'claude-code' });
    expect(upsertRule(rules, { match: 'git.push', action: 'deny', agent: '' })).toEqual([{ match: 'git.push', action: 'deny' }]);
    expect(removeRule(both, { match: 'git.push', agent: 'claude-code' })).toEqual(rules);
    expect(removeRule(both, { match: 'git.push' })).toEqual([{ match: 'git.push', action: 'allow', agent: 'claude-code' }]);
    expect(sameRule({ match: 'a' }, { match: 'a', agent: '' })).toBe(true);
    expect(sameRule({ match: 'a' }, { match: 'a', agent: 'x' })).toBe(false);
  });
});
