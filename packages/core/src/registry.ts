import { maskArguments, type AgentCallDecision } from './approvals';
import { QuiverError } from './errors';
import { decideAgentPermission, workspaceRulesFor } from './permissions';
import type { AnyZodObject, CommandContext, CommandDefinition, CommandMeta, ModuleMain } from './types';

/** Filled in by `execute` for an `mcp` call: how the call got past the permissions, or why it did not. */
export interface ExecuteTrace {
  decision?: AgentCallDecision;
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
    const permissions = mcp.permissions ?? { mode: mcp.allowMutating ? 'allow' : 'read-only', rules: [] };
    const decision = decideAgentPermission({ commandId: id, mutating: mutates, permissions, workspaceRules: workspaceRulesFor(mcp, ctx.workspace?.id) });
    if (decision.action === 'allow') {
      trace.decision = 'allowed';
      return;
    }
    if (decision.action === 'deny') {
      if (decision.source === 'mode') {
        refuse('refused', 'read-only', `Command "${id}" can change data and agents are read-only. The user can allow it, or have Quiver ask each time, in Settings > MCP.`);
      }
      refuse('refused', 'rule', `Command "${id}" is denied to agents by a ${decision.level} rule (${decision.rule?.match}) in Settings > MCP.`, { rule: decision.rule, level: decision.level });
    }

    if (!ctx.host.approvals) refuse('refused', 'no-approver', `Command "${id}" needs the user's approval, and this Quiver has no window to ask in.`);
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
    const outcome = await ctx.host.approvals!.request({ agent, workspace, commandId: id, title: command.title, input: maskArguments(input), mutating: mutates }, ctx.signal);
    if (outcome.approved) {
      trace.decision = 'approved';
      return;
    }
    if (outcome.reason === 'approval-timeout') refuse('approval-timeout', 'approval-timeout', `Command "${id}" waited for the user's approval and got no answer in time.`);
    if (outcome.reason === 'paused') refuse('paused', 'paused', `Command "${id}" was waiting for the user's approval when agents were paused.`);
    if (outcome.reason === 'cancelled') refuse('cancelled', 'cancelled', `Command "${id}" stopped waiting for the user's approval because the call was cancelled.`);
    refuse('denied', 'denied', `The user denied "${id}".`);
  }
}

/** Typed helper so module authors get inference on `handler` from `input`. */
export function defineCommand<S extends AnyZodObject, O>(def: CommandDefinition<S, O>): CommandDefinition {
  return def as unknown as CommandDefinition;
}

export function defineModule(mod: ModuleMain): ModuleMain {
  return mod;
}
