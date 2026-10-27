import { maskArguments, type AgentCallDecision } from './approvals';
import { QuiverError } from './errors';
import { decideAgentPermission, workspaceRulesFor } from './permissions';
import type { AnyZodObject, CommandActionsInfo, CommandContext, CommandDefinition, CommandMeta, ModuleMain } from './types';

/** Filled in by `execute` for an `mcp` call: how the call got past the permissions, or why it did not. */
export interface ExecuteTrace {
  decision?: AgentCallDecision;
  /** What the call does, for a command that declares actions; absent when it declares none or `of` failed. */
  action?: string;
}

/** The commands whose `actions.of` threw already, so the error is logged once per command. */
const actionErrorsLogged = new Set<string>();

/**
 * The action of one call to a command that declares actions, or undefined: for a command without actions, and when
 * `of` throws (logged once per command), in which case only the rules for the whole command apply.
 */
export async function actionOf(command: CommandDefinition, input: unknown, ctx: CommandContext): Promise<string | undefined> {
  if (!command.actions) return undefined;
  try {
    const action = await command.actions.of(input as never, ctx);
    return typeof action === 'string' && action ? action : undefined;
  } catch (err) {
    if (!actionErrorsLogged.has(command.id)) {
      actionErrorsLogged.add(command.id);
      console.warn(`[quiver] could not tell the action of a ${command.id} call; its command-level agent rules apply: ${(err as Error)?.message ?? err}`);
    }
    return undefined;
  }
}

interface Registered {
  module: string;
  command: CommandDefinition;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Registered>();
  private readonly modules = new Map<string, ModuleMain>();

  register(moduleId: string, command: CommandDefinition): void {
    if (this.commands.has(command.id)) {
      throw new Error(`Command "${command.id}" is registered twice`);
    }
    this.commands.set(command.id, { module: moduleId, command });
  }

  registerModule(mod: ModuleMain): void {
    this.modules.set(mod.id, mod);
    for (const cmd of mod.commands) this.register(mod.id, cmd);
  }

  listModules(): ModuleMain[] {
    return [...this.modules.values()];
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): Registered | undefined {
    return this.commands.get(id);
  }

  list(): CommandMeta[] {
    return [...this.commands.values()].map(({ module, command }) => ({
      id: command.id,
      module,
      title: command.title,
      description: command.description,
      scope: command.scope,
      mutating: Boolean(command.mutating),
      conditional: typeof command.mutating === 'function',
      hidden: Boolean(command.hidden),
      noInput: command.input.safeParse({}).success,
    }));
  }

  /** The commands that declare actions, for agent rules (`db.query.run#ddl`). Hidden commands are left out. */
  listActions(): CommandActionsInfo[] {
    return [...this.commands.values()]
      .filter(({ command }) => command.actions && !command.hidden)
      .map(({ command }) => ({ commandId: command.id, actions: [...command.actions!.list], describe: { ...(command.actions!.describe ?? {}) } }));
  }

  async execute<O = unknown>(id: string, rawInput: unknown, ctx: CommandContext, trace: ExecuteTrace = {}): Promise<O> {
    const entry = this.commands.get(id);
    if (!entry) throw new QuiverError('UNKNOWN_COMMAND', `Unknown command "${id}"`);
    const { command } = entry;

    if (command.scope === 'workspace' && !ctx.workspace) {
      throw new QuiverError('NO_WORKSPACE', `Command "${id}" needs an open workspace`);
    }
    const parsed = command.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
      throw new QuiverError('INVALID_INPUT', `Invalid input for "${id}": ${issues}`, parsed.error.issues);
    }

    // Agents only: the UI is the user, and the CLI is the user's own process.
    if (ctx.caller === 'mcp') await this.authorize(command, parsed.data, ctx, trace);
    return (await command.handler(parsed.data, ctx)) as O;
  }

  /** Lets an agent's call through, asks the user about it, or refuses it, as the permissions say. */
  private async authorize(command: CommandDefinition, input: unknown, ctx: CommandContext, trace: ExecuteTrace): Promise<void> {
    const { id } = command;
    const mcp = ctx.host.config.get().mcp;
    const refuse = (decision: AgentCallDecision, reason: string, message: string, extra: Record<string, unknown> = {}): never => {
      trace.decision = decision;
      throw new QuiverError('MUTATION_BLOCKED', message, { reason, ...extra });
    };
    if (mcp.paused) refuse('paused', 'paused', 'Agents are paused in Quiver. The user can resume them from the status bar or Settings > MCP.');

    const mutates = typeof command.mutating === 'function' ? await command.mutating(input as never, ctx) : Boolean(command.mutating);
    const action = await actionOf(command, input, ctx);
    if (action) trace.action = action;
    const agentName = ctx.agent?.name;
    const decide = (config: typeof mcp) =>
      decideAgentPermission({
        commandId: id,
        mutating: mutates,
        permissions: config.permissions ?? { mode: config.allowMutating ? 'allow' : 'read-only', rules: [] },
        workspaceRules: workspaceRulesFor(config, ctx.workspace?.id, command.scope),
        action,
        agent: agentName,
      });
    const what = action ? `"${id}" (${action})` : `"${id}"`;
    const actionDetails = action ? { action } : {};
    const refuseDenied = (decision: ReturnType<typeof decide>): void => {
      if (decision.action !== 'deny') return;
      if (decision.source === 'mode') {
        refuse('refused', 'read-only', `Command ${what} can change data and agents are read-only. The user can allow it, or have Quiver ask each time, in Settings > MCP.`, actionDetails);
      }
      const forAgent = decision.rule?.agent ? ` for ${decision.rule.agent}` : '';
      refuse('refused', 'rule', `Command ${what} is denied to agents by a ${decision.level} rule (${decision.rule?.match}${forAgent}) in Settings > MCP.`, { rule: decision.rule, level: decision.level, ...actionDetails });
    };
    const decision = decide(mcp);
    if (decision.action === 'allow') {
      trace.decision = 'allowed';
      return;
    }
    refuseDenied(decision);

    if (!ctx.host.approvals) refuse('refused', 'no-approver', `Command ${what} needs the user's approval, and this Quiver has no window to ask in.`, actionDetails);
    if (command.beforeApproval) {
      try {
        await command.beforeApproval(input as never, ctx);
      } catch (err) {
        trace.decision = 'refused';
        throw err;
      }
    }
    const workspace = ctx.workspace ? { id: ctx.workspace.id, name: ctx.workspace.name, path: ctx.workspace.path } : null;
    const agent = ctx.agent ?? { name: 'unknown', version: null, userAgent: null };
    const outcome = await ctx.host.approvals!.request({ agent, workspace, commandId: id, title: command.title, input: maskArguments(input), mutating: mutates, ...actionDetails }, ctx.signal);
    if (outcome.approved) {
      // The user may have paused agents or made the permissions stricter while the call waited; that wins.
      const now = ctx.host.config.get().mcp;
      if (now.paused) refuse('paused', 'paused', `Command "${id}" was waiting for the user's approval when agents were paused.`);
      refuseDenied(decide(now));
      trace.decision = 'approved';
      return;
    }
    if (outcome.reason === 'approval-timeout') refuse('approval-timeout', 'approval-timeout', `Command ${what} waited for the user's approval and got no answer in time.`, actionDetails);
    if (outcome.reason === 'paused') refuse('paused', 'paused', `Command ${what} was waiting for the user's approval when agents were paused.`, actionDetails);
    if (outcome.reason === 'cancelled') refuse('cancelled', 'cancelled', `Command ${what} stopped waiting for the user's approval because the call was cancelled.`, actionDetails);
    refuse('denied', 'denied', `The user denied ${what}.`, actionDetails);
  }
}

/** Typed helper so module authors get inference on `handler` from `input`. */
export function defineCommand<S extends AnyZodObject, O>(def: CommandDefinition<S, O>): CommandDefinition {
  return def as unknown as CommandDefinition;
}

export function defineModule(mod: ModuleMain): ModuleMain {
  return mod;
}
