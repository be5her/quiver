import { QuiverError } from './errors';
import type { McpAgent } from './models/mcp-recording';
import { REDACTED, isSecretName, redactLiteral, redactUrl } from './redact';
import type { WorkspaceInfo } from './types';

/** An agent's call that waits for the user, as the approval dialog shows it. */
export interface ApprovalRequest {
  agent: McpAgent;
  workspace: WorkspaceInfo | null;
  commandId: string;
  title: string;
  /** The arguments with credentials masked (`maskArguments`). */
  input: unknown;
  mutating: boolean;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  at: string;
  /** When the call is refused unless answered. */
  expiresAt: string;
}

/** Allow this call, allow the tool for this agent until Quiver restarts, allow the tool for good (a rule), or refuse. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

/** Why a waiting call was refused: the user denied it, nobody answered in time, agents were paused, or the agent went away (`cancelled`). */
export type ApprovalRefusal = 'denied' | 'approval-timeout' | 'paused' | 'cancelled';

export type ApprovalOutcome = { approved: true; how: 'once' | 'session' | 'always' | 'granted' } | { approved: false; reason: ApprovalRefusal };

/** An agent and a tool the user allowed until Quiver restarts. */
export interface ApprovalGrant {
  agent: string;
  commandId: string;
}

export const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_STRING = 4000;

export interface AgentApprovalsOptions {
  timeoutMs?: number;
  now?(): number;
  /** The pending list changed: a request arrived, was answered or ran out of time. */
  onChange?(pending: PendingApproval[]): void;
  /** A new request is waiting for the user. */
  onRequest?(pending: PendingApproval): void;
}

interface Waiting {
  pending: PendingApproval;
  resolve(outcome: ApprovalOutcome): void;
  timer: ReturnType<typeof setTimeout>;
  /** Stops listening to the caller's abort signal. */
  release(): void;
}

/**
 * The agent calls waiting for the user, oldest first, and the tools the user allowed per agent until Quiver
 * restarts. In memory only. A call that is not answered within `timeoutMs` is refused.
 */
export class AgentApprovals {
  /** Settable, so a test can wait less than two minutes for a timeout. */
  timeoutMs: number;
  private readonly waiting = new Map<string, Waiting>();
  private readonly granted = new Set<string>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly options: AgentApprovalsOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Waits for the user's answer, or answers at once when the user already allowed the tool for this agent. When
   * `signal` aborts (the agent's connection closed or it cancelled the call) the call stops waiting and is refused, so
   * an answer given later cannot run a call nobody waits for.
   */
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (this.isGranted(request.agent.name, request.commandId)) return Promise.resolve({ approved: true, how: 'granted' });
    if (signal?.aborted) return Promise.resolve({ approved: false, reason: 'cancelled' });
    const id = String(++this.seq);
    const at = this.now();
    const pending: PendingApproval = { ...request, id, at: new Date(at).toISOString(), expiresAt: new Date(at + this.timeoutMs).toISOString() };
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { approved: false, reason: 'approval-timeout' }), this.timeoutMs);
      (timer as { unref?(): void }).unref?.();
      const onAbort = () => this.settle(id, { approved: false, reason: 'cancelled' });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, { pending, resolve, timer, release: () => signal?.removeEventListener('abort', onAbort) });
      this.options.onRequest?.(pending);
      this.changed();
    });
  }

  /**
   * Answers a waiting call. Allowing for the session also lets through the agent's other calls to the tool that wait,
   * and allowing for good every agent's; with `workspaceId` (an allow for good that only holds in one workspace), only
   * those waiting in that workspace.
   */
  respond(id: string, choice: ApprovalChoice, scope: { workspaceId?: string | null } = {}): PendingApproval {
    const entry = this.waiting.get(id);
    if (!entry) throw new QuiverError('NOT_FOUND', `No approval ${id} is waiting; it may have been answered or timed out`);
    const { pending } = entry;
    if (choice === 'deny') {
      this.settle(id, { approved: false, reason: 'denied' });
      return pending;
    }
    if (choice === 'session') this.granted.add(grantKey(pending.agent.name, pending.commandId));
    this.settle(id, { approved: true, how: choice }, false);
    if (choice !== 'once') {
      for (const other of [...this.waiting.values()]) {
        const inScope = scope.workspaceId === undefined || (other.pending.workspace?.id ?? null) === scope.workspaceId;
        const same = other.pending.commandId === pending.commandId && inScope && (choice === 'always' || other.pending.agent.name === pending.agent.name);
        if (same) this.settle(other.pending.id, { approved: true, how: choice }, false);
      }
    }
    this.changed();
    return pending;
  }

  /** Refuses every waiting call, e.g. when agents are paused. */
  refuseAll(reason: ApprovalRefusal): void {
    if (!this.waiting.size) return;
    for (const id of [...this.waiting.keys()]) this.settle(id, { approved: false, reason }, false);
    this.changed();
  }

  list(): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.pending);
  }

  isGranted(agent: string, commandId: string): boolean {
    return this.granted.has(grantKey(agent, commandId));
  }

  grants(): ApprovalGrant[] {
    return [...this.granted].map((key) => {
      const [agent, commandId] = key.split('\u0000');
      return { agent, commandId };
    });
  }

  /** Takes back what was allowed until restart. */
  clearGrants(): void {
    this.granted.clear();
  }

  private settle(id: string, outcome: ApprovalOutcome, notify = true): void {
    const entry = this.waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.release();
    this.waiting.delete(id);
    entry.resolve(outcome);
    if (notify) this.changed();
  }

  private changed(): void {
    this.options.onChange?.(this.list());
  }
}

function grantKey(agent: string, commandId: string): string {
  return `${agent}\u0000${commandId}`;
}

/**
 * Arguments as the approval dialog shows them: values under a credential's name (`password`, `token`, `apiKey`), the
 * value of a `{ key, value }` row whose key is one, and credentials in URLs are masked; very long strings are cut.
 */
export function maskArguments(value: unknown, name = ''): unknown {
  if (typeof value === 'string') {
    if (name && isSecretName(name)) return redactLiteral(value);
    const masked = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.trim()) ? redactUrl(value) : value;
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}… (${masked.length - MAX_STRING} more characters)` : masked;
  }
  if (Array.isArray(value)) return value.map((item) => maskArguments(item, name));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // A header, parameter or variable row: the secret is in `value`, its name in `key` or `name`.
    const rowName = typeof record.key === 'string' ? record.key : typeof record.name === 'string' ? record.name : '';
    const rowIsSecret = (rowName && isSecretName(rowName)) || record.secret === true;
    return Object.fromEntries(
      Object.entries(record).map(([key, inner]) => {
        if (key === 'key' && 'value' in record) return [key, inner];
        if (key === 'value' && rowIsSecret) return [key, typeof inner === 'string' ? redactLiteral(inner) : REDACTED];
        if (isSecretName(key) && inner !== null && typeof inner !== 'boolean' && typeof inner !== 'object') return [key, typeof inner === 'string' ? redactLiteral(inner) : REDACTED];
        return [key, maskArguments(inner, key)];
      }),
    );
  }
  return value;
}

/** How an agent's call got past the permissions, or why it did not. */
export type AgentCallDecision = 'allowed' | 'approved' | 'refused' | 'denied' | 'approval-timeout' | 'paused' | 'cancelled';

/** One MCP call in the activity feed. No arguments or results, so nothing sensitive is kept. */
export interface AgentActivityEntry {
  id: number;
  at: string;
  agent: Pick<McpAgent, 'name' | 'version'>;
  /** The command id, e.g. `db.query.run`. */
  tool: string;
  workspace: Pick<WorkspaceInfo, 'id' | 'name'> | null;
  /** Null when the call failed before the permissions were looked at, e.g. on invalid arguments. */
  decision: AgentCallDecision | null;
  ok: boolean;
  durationMs: number;
}

/** How many calls the activity feed keeps. */
export const AGENT_ACTIVITY_SIZE = 200;
