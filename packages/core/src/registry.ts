import { QuiverError } from './errors';
import type { AnyZodObject, CommandContext, CommandDefinition, CommandMeta, ModuleMain } from './types';

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

  async execute<O = unknown>(id: string, rawInput: unknown, ctx: CommandContext): Promise<O> {
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

    if (ctx.caller === 'mcp' && !ctx.host.config.get().mcp.allowMutating) {
      const mutates = typeof command.mutating === 'function' ? await command.mutating(parsed.data, ctx) : Boolean(command.mutating);
      if (mutates) {
        throw new QuiverError(
          'MUTATION_BLOCKED',
          `Command "${id}" can change data and MCP mutations are disabled. Enable them in Settings > MCP.`,
        );
      }
    }
    return (await command.handler(parsed.data, ctx)) as O;
  }
}

/** Typed helper so module authors get inference on `handler` from `input`. */
export function defineCommand<S extends AnyZodObject, O>(def: CommandDefinition<S, O>): CommandDefinition {
  return def as unknown as CommandDefinition;
}

export function defineModule(mod: ModuleMain): ModuleMain {
  return mod;
}
