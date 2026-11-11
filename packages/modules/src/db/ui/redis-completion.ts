import {
  REDIS_COMMANDS,
  quoteRedisArgument,
  redisCommandAction,
  redisCompletionContext,
  redisSignature,
  redisSubcommands,
  type RedisCommandSpec,
  type RedisCompletionContext,
  type RedisKeySuggestions,
} from '@quiver/core';
import type { Completion, CompletionContext, CompletionResult, CompletionSource, HostBridge } from '@quiver/ui';

/** Wait this long after the last keystroke before asking the server for keys. */
const KEY_DEBOUNCE_MS = 150;
/** Key suggestions are reused this long for the same prefix (and a longer one, when the list was complete). */
const KEY_CACHE_MS = 10_000;
const KEY_LIMIT = 200;

const DETAIL_MAX = 48;

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function commandCompletion(spec: RedisCommandSpec, label = spec.name): Completion {
  const action = redisCommandAction(spec.name.split(' '));
  return {
    label,
    detail: shorten(spec.args, DETAIL_MAX),
    info: `${redisSignature(spec)}\n\n${spec.summary}\n${spec.group} · ${action}`,
    type: action === 'read' ? 'function' : action === 'admin' ? 'keyword' : 'method',
  };
}

const COMMAND_OPTIONS: Completion[] = REDIS_COMMANDS.map((spec) => commandCompletion(spec));

/** The upper-case words of a command's syntax (NX, EX, WITHSCORES…), offered as its options. */
function keywordOptions(spec: RedisCommandSpec): Completion[] {
  const words = new Set(spec.args.match(/\b[A-Z][A-Z0-9_-]*[A-Z0-9]\b/g) ?? []);
  return [...words].map((w) => ({ label: w, type: 'constant', detail: 'option' }));
}

/** The command (or the subcommands) at the cursor, for the hint under the console. */
export interface RedisHint {
  signature: string;
  summary: string;
}

export function redisHintAt(text: string, offset: number): RedisHint | null {
  const ctx = redisCompletionContext(text.slice(0, offset), offset);
  if (!ctx) return null;
  if (ctx.command) return { signature: redisSignature(ctx.command), summary: ctx.command.summary };
  if (ctx.kind === 'subcommand' && ctx.container) {
    const subs = redisSubcommands(ctx.container).map((c) => c.name.slice(ctx.container!.length + 1));
    return { signature: `${ctx.container} ${subs.join(' | ')}`, summary: 'Pick a subcommand.' };
  }
  if (ctx.kind === 'command' && ctx.prefix) {
    const spec = REDIS_COMMANDS.find((c) => c.name === ctx.prefix.toUpperCase());
    if (spec) return { signature: redisSignature(spec), summary: spec.summary };
  }
  return null;
}

interface CacheEntry {
  at: number;
  result: Promise<RedisKeySuggestions>;
}

/**
 * Completion for the Redis console: command names (two-word ones too), subcommands, the options of the
 * command being typed, and in a key position the keys starting with what is typed (`db.redis.suggest`,
 * debounced and cached briefly). A failure to list keys (signed out of Grafana, a broken connection)
 * leaves only the command completion.
 */
export class RedisCompleter {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly host: HostBridge,
    private readonly connectionId: () => string | null,
  ) {}

  readonly source: CompletionSource = (context) => this.complete(context);

  /** Forget the keys seen, after a command that may have created or deleted some. */
  clear(): void {
    this.cache.clear();
  }

  private async complete(context: CompletionContext): Promise<CompletionResult | null> {
    const ctx = redisCompletionContext(context.state.sliceDoc(0, context.pos), context.pos);
    if (!ctx) return null;
    switch (ctx.kind) {
      case 'command':
        if (!ctx.prefix && !context.explicit) return null;
        return { from: ctx.from, options: COMMAND_OPTIONS, validFor: /^[\w.-]*$/ };
      case 'subcommand': {
        const container = ctx.container!;
        return { from: ctx.from, options: redisSubcommands(container).map((spec) => commandCompletion(spec, spec.name.slice(container.length + 1))), validFor: /^[\w.-]*$/ };
      }
      case 'key':
        return this.keys(context, ctx);
      default:
        if (!ctx.command || ctx.quote || (!ctx.prefix && !context.explicit)) return null;
        return { from: ctx.from, options: keywordOptions(ctx.command), validFor: /^[\w-]*$/ };
    }
  }

  private async keys(context: CompletionContext, ctx: RedisCompletionContext): Promise<CompletionResult | null> {
    const connectionId = this.connectionId();
    if (!connectionId) return null;
    if (!context.explicit) {
      await new Promise((resolve) => setTimeout(resolve, KEY_DEBOUNCE_MS));
      if (context.aborted) return null;
    }
    const found = await this.lookup(connectionId, ctx.prefix);
    if (context.aborted || !found.keys.length) return null;
    const keys = found.keys.filter((k) => k.startsWith(ctx.prefix));
    // Typed bare, the list filters itself as more is typed; inside quotes or escapes it is already the match.
    const bare = !ctx.quote && context.state.sliceDoc(ctx.from, context.pos) === ctx.prefix;
    return {
      from: ctx.from,
      options: keys.map((key) => ({ label: key, type: 'variable', apply: quoteRedisArgument(key) })),
      ...(bare ? (found.complete ? { validFor: /^[^\s"'\\]*$/ } : {}) : { filter: false }),
    };
  }

  /** The keys for `prefix`: a fresh result for it, or a fresh complete one for a shorter prefix, or a new scan. */
  private lookup(connectionId: string, prefix: string): Promise<RedisKeySuggestions> {
    const now = Date.now();
    for (const [id, entry] of this.cache) if (now - entry.at > KEY_CACHE_MS) this.cache.delete(id);
    const id = `${connectionId}\u0000${prefix}`;
    const hit = this.cache.get(id);
    if (hit) return hit.result;
    for (let n = prefix.length - 1; n >= 0; n--) {
      const shorter = this.cache.get(`${connectionId}\u0000${prefix.slice(0, n)}`);
      if (shorter) {
        const result = shorter.result.then((r) => (r.complete ? { keys: r.keys.filter((k) => k.startsWith(prefix)), complete: true } : null));
        // Only a complete list can answer for a longer prefix; otherwise scan for it.
        return result.then((r) => r ?? this.scan(connectionId, prefix, id));
      }
    }
    return this.scan(connectionId, prefix, id);
  }

  private scan(connectionId: string, prefix: string, id: string): Promise<RedisKeySuggestions> {
    const result = this.host.invoke<RedisKeySuggestions>('db.redis.suggest', { connectionId, prefix, limit: KEY_LIMIT }).catch((): RedisKeySuggestions => ({ keys: [], complete: false }));
    this.cache.set(id, { at: Date.now(), result });
    return result;
  }
}
