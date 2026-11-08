import type { McpConfig } from './types';

/** What a mutating MCP call gets when no rule matches it: refused, asked about, or let through. */
export type AgentPermissionMode = 'read-only' | 'ask' | 'allow';

export type AgentRuleAction = 'allow' | 'ask' | 'deny';

/**
 * One rule: a command id (`db.query.run`), a command id and one of its actions (`db.query.run#ddl`), a prefix glob
 * (`git.*`, `git.branch.*`) or `*`, and what calls it matches get. With `agent`, it only applies to the agent of that
 * name (the client name from the MCP handshake, as the activity feed shows it).
 */
export interface AgentPermissionRule {
  match: string;
  action: AgentRuleAction;
  agent?: string;
}

/** The agent permissions in the global config (`mcp.permissions`). */
export interface AgentPermissions {
  mode: AgentPermissionMode;
  rules: AgentPermissionRule[];
}


export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = ['read-only', 'ask', 'allow'];
export const AGENT_RULE_ACTIONS: readonly AgentRuleAction[] = ['allow', 'ask', 'deny'];

/** What one call gets, and why. */
export interface AgentPermissionDecision {
  action: AgentRuleAction;
  /** `rule` when a rule decided, `mode` when a mutating call fell through to the mode, `default` when a read-only call did. */
  source: 'rule' | 'mode' | 'default';
  /** The deciding rule and the level it came from. */
  rule?: AgentPermissionRule;
  level?: 'workspace' | 'global';
}

const ID = '[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*';
const ACTION_NAME = '[A-Za-z0-9_-]+';
const MATCH = new RegExp(`^(?:\\*|${ID}(?:\\.\\*)?|${ID}#${ACTION_NAME})$`);

/** What a rule's match should look like, for the messages that refuse one. */
export const RULE_MATCH_GRAMMAR = 'a command id (db.query.run), a command id and one of its actions (db.query.run#ddl), a glob ending in .* (git.*, git.branch.*) or * for every tool';

/** Whether a rule's match is a command id, a command id with `#<action>`, a prefix glob ending in `.*`, or `*`. */
export function isValidRuleMatch(match: string): boolean {
  return MATCH.test(match);
}

/** A match split into the part naming commands and the action after `#`, if any. */
export function parseRuleMatch(match: string): { command: string; action?: string } {
  const at = match.indexOf('#');
  return at < 0 ? { command: match } : { command: match.slice(0, at), action: match.slice(at + 1) };
}

/** A match for a command, or for one action of it. */
export function ruleMatchFor(commandId: string, action?: string | null): string {
  return action ? `${commandId}#${action}` : commandId;
}

/** Whether the part of a match before any `#` names the command: `*`, a glob it falls under, or its id. */
export function ruleMatchesCommand(match: string, commandId: string): boolean {
  const { command } = parseRuleMatch(match);
  if (command === '*') return true;
  if (command.endsWith('.*')) return commandId.startsWith(command.slice(0, -1));
  return command === commandId;
}

/** The specificity of an exact command id, above any glob; `id#action` is above that. */
const EXACT = 1_000_000;

/**
 * How specifically a rule's match names a call, or -1 when it does not match: `*` is 0, a glob counts the segments
 * before its `.*` (`git.*` is 1, `git.branch.*` is 2), an exact id beats every glob, and `id#action` beats the id. A
 * match with an action only matches a call with that action: one whose action is unknown is matched by the
 * command-level rules alone.
 */
export function ruleSpecificity(match: string, commandId: string, action?: string | null): number {
  if (match === '*') return 0;
  if (match.endsWith('.*')) {
    const prefix = match.slice(0, -1);
    return commandId.startsWith(prefix) ? prefix.split('.').length - 1 : -1;
  }
  const parsed = parseRuleMatch(match);
  if (parsed.command !== commandId) return -1;
  if (parsed.action === undefined) return EXACT;
  return action && parsed.action === action ? 2 * EXACT : -1;
}

/** Whether a rule applies to an agent: a rule without `agent` applies to every agent. */
export function ruleAppliesToAgent(rule: Pick<AgentPermissionRule, 'agent'>, agent?: string | null): boolean {
  return !rule.agent || rule.agent === agent;
}

const STRICTNESS: Record<AgentRuleAction, number> = { allow: 0, ask: 1, deny: 2 };

/** A call as the rules see it: the command, the action of this call when the command declares actions, and the agent. */
interface RuleTarget {
  commandId: string;
  action?: string | null;
  agent?: string | null;
}

/**
 * The most specific of the rules that match, the stricter one on a tie. At equal specificity a rule for this agent
 * beats one for every agent; a rule for another agent is skipped.
 */
function mostSpecific(rules: AgentPermissionRule[], target: RuleTarget): AgentPermissionRule | undefined {
  let best: { rule: AgentPermissionRule; score: number } | undefined;
  for (const rule of rules) {
    if (!ruleAppliesToAgent(rule, target.agent)) continue;
    const specificity = ruleSpecificity(rule.match, target.commandId, target.action);
    if (specificity < 0) continue;
    const score = specificity * 2 + (rule.agent ? 1 : 0);
    if (!best || score > best.score || (score === best.score && STRICTNESS[rule.action] > STRICTNESS[best.rule.action])) best = { rule, score };
  }
  return best?.rule;
}

/**
 * What an agent's call to a command gets. A `deny` rule that matches, in the workspace or the global rules, beats
 * everything. Then the most specific matching workspace rule decides, then the most specific global one. With no
 * rule, a read-only call is allowed and a mutating one gets the mode.
 *
 * `action` is what this call does, for a command that declares actions (`ddl` for a `db.query.run` with a `CREATE
 * TABLE`); `id#action` rules only match a call with that action. `agent` is the agent's name; rules for another agent
 * are skipped.
 */
export function decideAgentPermission(options: {
  commandId: string;
  mutating: boolean;
  permissions: AgentPermissions;
  workspaceRules?: AgentPermissionRule[];
  action?: string | null;
  agent?: string | null;
}): AgentPermissionDecision {
  const { commandId, mutating, permissions } = options;
  const target: RuleTarget = { commandId, action: options.action, agent: options.agent };
  const levels = [
    { level: 'workspace' as const, rules: options.workspaceRules ?? [] },
    { level: 'global' as const, rules: permissions.rules },
  ];
  for (const { level, rules } of levels) {
    const deny = mostSpecific(
      rules.filter((r) => r.action === 'deny'),
      target,
    );
    if (deny) return { action: 'deny', source: 'rule', rule: deny, level };
  }
  for (const { level, rules } of levels) {
    const rule = mostSpecific(rules, target);
    if (rule) return { action: rule.action, source: 'rule', rule, level };
  }
  if (!mutating) return { action: 'allow', source: 'default' };
  return { action: permissions.mode === 'read-only' ? 'deny' : permissions.mode, source: 'mode' };
}

/** An agent name as a rule keeps it: trimmed, and absent when empty. */
function agentName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Rules as they may come from a hand-edited file: anything that is not a valid rule is dropped. */
export function normalizeRules(rules: unknown): AgentPermissionRule[] {
  if (!Array.isArray(rules)) return [];
  return rules.flatMap((r) => {
    const rule = r as Partial<AgentPermissionRule> | null;
    if (typeof rule?.match !== 'string' || !isValidRuleMatch(rule.match.trim()) || !AGENT_RULE_ACTIONS.includes(rule.action as AgentRuleAction)) return [];
    const agent = agentName(rule.agent);
    return [{ match: rule.match.trim(), action: rule.action as AgentRuleAction, ...(agent ? { agent } : {}) }];
  });
}

/** Whether two rules are the same rule (the same match for the same agent), whatever they decide. */
export function sameRule(a: Pick<AgentPermissionRule, 'match' | 'agent'>, b: Pick<AgentPermissionRule, 'match' | 'agent'>): boolean {
  return a.match === b.match && (agentName(a.agent) ?? '') === (agentName(b.agent) ?? '');
}

/** Adds a rule, or replaces the one with the same match for the same agent. */
export function upsertRule(rules: AgentPermissionRule[], rule: AgentPermissionRule): AgentPermissionRule[] {
  const agent = agentName(rule.agent);
  const clean: AgentPermissionRule = { match: rule.match, action: rule.action, ...(agent ? { agent } : {}) };
  const at = rules.findIndex((r) => sameRule(r, clean));
  return at < 0 ? [...rules, clean] : rules.map((r, i) => (i === at ? clean : r));
}

/** The rules without the one with this match for this agent. */
export function removeRule(rules: AgentPermissionRule[], rule: Pick<AgentPermissionRule, 'match' | 'agent'>): AgentPermissionRule[] {
  return rules.filter((r) => !sameRule(r, rule));
}

/**
 * The MCP section after a load or an update, `before` being what it was. Older configs only have `allowMutating`:
 * when it differs from `before` while the mode stayed, it picks the mode (true is `allow`, false `read-only`), so a
 * config written by an older build, or a patch that only flips it, keeps its meaning. It is then kept in step with
 * the mode, so an older build reading the file refuses mutations unless the mode is `allow`. On load (`loaded`), a
 * file that says `allowMutating: false` beside mode `allow` was switched off by an older build, which only knows
 * `allowMutating`, so it loads as `read-only`: the stricter of the two.
 */
export function migrateMcpConfig(merged: McpConfig, before: McpConfig, loaded = false): McpConfig {
  // A patch that names only the mode, or only the rules, keeps the other.
  const given = { ...before.permissions, ...(merged.permissions as Partial<AgentPermissions> | undefined) } as Partial<AgentPermissions>;
  let mode: AgentPermissionMode = AGENT_PERMISSION_MODES.includes(given.mode as AgentPermissionMode) ? (given.mode as AgentPermissionMode) : 'read-only';
  const flipped = Boolean(merged.allowMutating) !== Boolean(before.allowMutating);
  if (flipped && mode === before.permissions?.mode) mode = merged.allowMutating ? 'allow' : 'read-only';
  if (loaded && merged.allowMutating === false && mode === 'allow') mode = 'read-only';
  return {
    ...merged,
    allowMutating: mode === 'allow',
    paused: merged.paused === true,
    permissions: { mode, rules: normalizeRules(given.rules) },
    workspaceRules: normalizeWorkspaceRules(merged.workspaceRules),
  };
}

/** The per-workspace rules as a hand-edited file may hold them: invalid rules dropped, and workspaces left with none. */
function normalizeWorkspaceRules(value: unknown): Record<string, AgentPermissionRule[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([id, rules]) => [id, normalizeRules(rules)] as const)
      .filter(([, rules]) => rules.length > 0),
  );
}

/**
 * A workspace's own rules. They live in the global config (`mcp.workspaceRules`, by workspace id), on this machine
 * only, and never in the project: a file in the project could come from anyone who can commit to it, and these rules
 * can allow more than the global ones. For a global command (`scope` 'global': Teleport, app updates, global
 * variables) only the deny and ask rules count, so a loose rule in a scratch workspace never lets an agent connected
 * there do more outside it.
 */
export function workspaceRulesFor(mcp: Pick<McpConfig, 'workspaceRules'>, workspaceId: string | undefined | null, scope: 'global' | 'workspace' = 'workspace'): AgentPermissionRule[] {
  const rules = (workspaceId && mcp.workspaceRules?.[workspaceId]) || [];
  return scope === 'global' ? rules.filter((r) => r.action !== 'allow') : rules;
}

/** `mcp.workspaceRules` with one workspace's rules replaced; a workspace left with none is dropped. */
export function withWorkspaceRules(mcp: Pick<McpConfig, 'workspaceRules'>, workspaceId: string, rules: AgentPermissionRule[]): Record<string, AgentPermissionRule[]> {
  const next = { ...(mcp.workspaceRules ?? {}) };
  if (rules.length) next[workspaceId] = rules;
  else delete next[workspaceId];
  return next;
}
