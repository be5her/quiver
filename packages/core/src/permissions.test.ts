import { describe, expect, it } from 'vitest';
import { defaultGlobalConfig } from './defaults';
import {
  decideAgentPermission,
  isValidRuleMatch,
  migrateMcpConfig,
  normalizeRules,
  ruleSpecificity,
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

  it('falls back to read-only for an unknown mode and to false for paused', () => {
    const odd = migrateMcpConfig({ ...defaults, permissions: { mode: 'yolo', rules: 'x' }, paused: 'yes' } as never, defaults);
    expect(odd).toMatchObject({ allowMutating: false, paused: false, permissions: { mode: 'read-only', rules: [] } });
  });
});
