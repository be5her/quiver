/**
 * The `quiver` command line (src/cli): its arguments parsed into what to run, field flags turned into a
 * command's input against the command's JSON schema, the exit codes, and the names headless runs read
 * secrets from. Pure, so it is unit tested here; the CLI itself does the reading, the network and the printing.
 */

/** What the CLI was asked to do. `run` executes `target`, a command id. */
export type CliVerb = 'help' | 'version' | 'list' | 'describe' | 'run';

export interface CliOptions {
  /** The project folder; the CLI defaults to the nearest folder up from the current one with a `.quiver`. */
  workspace?: string;
  /** JSON output; undefined lets the CLI decide (JSON when stdout is not a terminal). */
  json?: boolean;
  quiet: boolean;
  /** `on` runs in-process; `auto` does that only when no app answers; `off` needs the app. */
  headless: 'off' | 'on' | 'auto';
  /** Headless only: the folder for the global config and per-machine state. */
  dataDir?: string;
  /** Connected only: the app's user data folder, where it publishes its port and token. */
  userDataDir?: string;
  timeoutMs?: number;
  /** Headless only: a JSON file of secret name to value. */
  secrets?: string;
  reporter?: 'junit';
  /** Where the reporter writes; stdout when left out. */
  out?: string;
  /** JSON text, `@file.json` or `@-` for stdin, read by the CLI. */
  input?: string;
  /** `list --all` includes the hidden commands. */
  all: boolean;
}

/** A `--name value` (or bare `--name`, `true`) that is not one of the CLI's own options: a field of the command's input. */
export interface CliField {
  name: string;
  value: string | true;
}

export interface ParsedCli {
  verb: CliVerb;
  /** The command for run and describe, the module for list. */
  target?: string;
  options: CliOptions;
  fields: CliField[];
}

/** A command line or an input the CLI cannot use: exit code 2, with the message. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** Where the `quiver` command line reaches the running app, next to the MCP endpoint on the same port. */
export const CLI_PATH = '/cli';
/** The header that carries the token the app writes to `<userData>/cli-token`. */
export const CLI_TOKEN_HEADER = 'x-quiver-cli-token';

/**
 * Headers without the command line's token. Every outgoing request whose headers an agent can choose (realtime
 * connections, MCP servers, mock replays and forwards) goes through this, so an agent that read the token file
 * cannot relay a call to `/cli` through an open tool and run it as the user.
 */
export function withoutCliToken(headers: [string, string][]): [string, string][] {
  return headers.filter(([name]) => name.trim().toLowerCase() !== CLI_TOKEN_HEADER);
}

export const CLI_EXIT = {
  ok: 0,
  /** The command failed; its error goes to stderr as JSON. */
  failed: 1,
  /** A bad command line or an input the command refused. */
  usage: 2,
  /** Connected mode found no running Quiver to talk to. */
  unreachable: 3,
  /** The command ran, and its result reports failed checks. */
  checksFailed: 4,
} as const;

/** Options that take a value, by their flag name. */
const VALUE_OPTIONS = ['workspace', 'data-dir', 'user-data-dir', 'timeout', 'secrets', 'reporter', 'out', 'input'] as const;
/** Options that are on when given. `all` is one only for `list`; elsewhere it is a field like any other. */
const FLAG_OPTIONS = ['json', 'quiet', 'help', 'version', 'headless'] as const;
const VERBS: Record<string, CliVerb> = { help: 'help', version: 'version', list: 'list', describe: 'describe', run: 'run' };

/** The CLI's own option names, which a command's field of the same name cannot use as a flag (`--input` takes it). */
export const CLI_OPTION_NAMES: readonly string[] = [...VALUE_OPTIONS, ...FLAG_OPTIONS];

/** Seconds, as `30`, `1.5`, `500ms`, `2m` or `30s`, to milliseconds. */
export function parseTimeout(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim());
  if (!match) throw new CliUsageError(`--timeout takes seconds, such as 30, 1.5, 500ms or 2m; got "${text}"`);
  const value = Number(match[1]);
  const ms = match[2] === 'ms' ? value : match[2] === 'm' ? value * 60_000 : value * 1000;
  if (ms <= 0) throw new CliUsageError('--timeout must be more than zero');
  return Math.round(ms);
}

/**
 * Split the arguments into the verb, the CLI's options and the command's field flags. Options may come
 * anywhere; `--name=value` and `--name value` both work, and a bare `--name` (last, or followed by another
 * flag) is `true`. Values that start with `--` need the `=` form. Everything after `--` is positional.
 */
export function parseCliArgs(argv: string[]): ParsedCli {
  const options: CliOptions = { quiet: false, headless: 'off', all: false };
  const fields: CliField[] = [];
  const positional: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') help = true;
    else if (arg === '-q') options.quiet = true;
    else if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      if ((VALUE_OPTIONS as readonly string[]).includes(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new CliUsageError(`--${name} needs a value`);
        setValueOption(options, name as (typeof VALUE_OPTIONS)[number], value);
      } else if (name === 'headless') {
        if (inline === undefined || inline === 'on' || inline === 'true') options.headless = 'on';
        else if (inline === 'auto') options.headless = 'auto';
        else if (inline === 'off' || inline === 'false') options.headless = 'off';
        else throw new CliUsageError(`--headless takes nothing, =auto or =off; got "${inline}"`);
      } else if ((FLAG_OPTIONS as readonly string[]).includes(name)) {
        if (inline !== undefined && inline !== 'true' && inline !== 'false') throw new CliUsageError(`--${name} takes no value`);
        const on = inline !== 'false';
        if (name === 'json') options.json = on;
        else if (name === 'quiet') options.quiet = on;
        else if (name === 'help') help = on;
        else version = on;
      } else {
        if (!name || name.startsWith('-')) throw new CliUsageError(`Unknown option ${arg}`);
        const next = argv[i + 1];
        const value = inline ?? (next !== undefined && !next.startsWith('--') ? argv[++i] : true);
        fields.push({ name, value });
      }
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      throw new CliUsageError(`Unknown option ${arg}`);
    } else positional.push(arg);
  }

  const [first, second, ...rest] = positional;
  let verb: CliVerb;
  let target: string | undefined;
  let extra: string[];
  if (version && !first) return { verb: 'version', options, fields: [] };
  if (first === undefined || (help && !first)) {
    verb = 'help';
    extra = [];
  } else if (VERBS[first]) {
    verb = VERBS[first];
    target = second;
    extra = rest;
    if (verb === 'run' && !target) throw new CliUsageError('quiver run needs a command, such as quiver run todo.list');
    if (verb === 'describe' && !target) throw new CliUsageError('quiver describe needs a command, such as quiver describe todo.add');
    if (verb === 'version' && target) extra = [target, ...rest];
    if (verb === 'help' && target) verb = 'describe';
  } else {
    verb = 'run';
    target = first;
    extra = second === undefined ? [] : [second, ...rest];
  }
  // `quiver todo.add --help` describes the command instead of running it.
  if (help && verb === 'run') verb = 'describe';
  if (extra.length) throw new CliUsageError(`Unexpected argument "${extra[0]}"; a value that starts a new word needs quotes, and fields are given as --name value`);
  if (verb === 'list') {
    const all = fields.findIndex((f) => f.name === 'all');
    if (all !== -1) {
      options.all = fields[all].value !== 'false';
      fields.splice(all, 1);
    }
  }
  if (verb !== 'run' && fields.length) throw new CliUsageError(`Unknown option --${fields[0].name} for quiver ${verb}`);
  if (verb === 'run' && target && !/^[A-Za-z][\w-]*(\.[\w-]+)+$/.test(target)) throw new CliUsageError(`"${target}" is not a command id; ids look like todo.add, and quiver list shows them`);
  return { verb, target, options, fields };
}

function setValueOption(options: CliOptions, name: (typeof VALUE_OPTIONS)[number], value: string): void {
  switch (name) {
    case 'workspace':
      options.workspace = value;
      break;
    case 'data-dir':
      options.dataDir = value;
      break;
    case 'user-data-dir':
      options.userDataDir = value;
      break;
    case 'timeout':
      options.timeoutMs = parseTimeout(value);
      break;
    case 'secrets':
      options.secrets = value;
      break;
    case 'reporter':
      if (value !== 'junit') throw new CliUsageError(`--reporter knows junit; got "${value}"`);
      options.reporter = value;
      break;
    case 'out':
      options.out = value;
      break;
    case 'input':
      options.input = value;
      break;
  }
}

// ---------- input from flags ----------

/** The parts of a JSON schema (as zod's toJSONSchema writes it) that the CLI reads. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  default?: unknown;
  minimum?: number;
}

/** Every JSON type a value of this schema may have; empty when the schema does not say (anything goes). */
export function schemaTypes(schema: JsonSchema | undefined): Set<string> {
  const types = new Set<string>();
  if (!schema) return types;
  if (typeof schema.type === 'string') types.add(schema.type);
  else if (Array.isArray(schema.type)) for (const t of schema.type) types.add(t);
  for (const member of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) for (const t of schemaTypes(member)) types.add(t);
  for (const value of [...(schema.enum ?? []), ...('const' in schema ? [schema.const] : [])]) types.add(value === null ? 'null' : typeof value === 'number' ? 'number' : typeof value);
  if (types.has('integer')) types.add('number');
  return types;
}

/** The object schema with properties among a schema and its union members, for dotted names. */
function objectSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  if (schema.properties || schema.additionalProperties !== undefined) return schema;
  for (const member of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const found = objectSchema(member);
    if (found) return found;
  }
  return undefined;
}

function itemsSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  if (schema.items) return schema.items;
  for (const member of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const found = itemsSchema(member);
    if (found) return found;
  }
  return undefined;
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Keys every object inherits, which no flag may name. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The property a flag names in an object schema: the exact name, its kebab-case spelled in camelCase
 * (`--environment-id`), or the name with `Id` left off (`--collection` for `collectionId`). `no-<name>`
 * turns a boolean off. Null when the object has no such property and takes no other keys.
 */
export function resolveFieldName(name: string, schema: JsonSchema | undefined): { key: string; negate: boolean } | null {
  const object = objectSchema(schema);
  const props = object?.properties ?? {};
  // An object with listed properties takes no others (zod drops unknown keys); a record, or a schema that says nothing, takes any.
  const open = !object?.properties || (object.additionalProperties !== undefined && object.additionalProperties !== false);
  // Never a name an object inherits: `--__proto__.x` would otherwise write into Object.prototype.
  if (UNSAFE_KEYS.has(name)) return null;
  const candidates = (n: string) => [n, kebabToCamel(n), `${kebabToCamel(n)}Id`];
  for (const key of candidates(name)) if (Object.hasOwn(props, key)) return { key, negate: false };
  if (name.startsWith('no-')) {
    for (const key of candidates(name.slice(3))) if (Object.hasOwn(props, key) && schemaTypes(props[key]).has('boolean')) return { key, negate: true };
  }
  return open ? { key: name, negate: false } : null;
}

/** One flag value as the schema wants it. `flag` names it in errors. */
export function coerceValue(value: string | true, schema: JsonSchema | undefined, flag: string): unknown {
  const types = schemaTypes(schema);
  const any = types.size === 0;
  if (value === true) {
    if (any || types.has('boolean')) return true;
    throw new CliUsageError(`--${flag} needs a value`);
  }
  if (types.has('null') && value === 'null') return null;
  if (types.has('boolean') && (value === 'true' || value === 'false')) return value === 'true';
  if (types.has('number') && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(value.trim())) {
    const n = Number(value);
    if (types.has('integer') && !types.has('string') && !Number.isInteger(n)) throw new CliUsageError(`--${flag} takes a whole number; got ${value}`);
    return n;
  }
  const trimmed = value.trim();
  if ((types.has('object') || types.has('array') || any) && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      if (!any && !types.has('string')) throw new CliUsageError(`--${flag} is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (types.has('array') && !types.has('string')) return [coerceValue(value, itemsSchema(schema), flag)];
  if (any || types.has('string')) return value;
  if (schema?.enum && !schema.enum.includes(value)) throw new CliUsageError(`--${flag} is one of ${schema.enum.join(', ')}; got "${value}"`);
  if (types.has('number')) throw new CliUsageError(`--${flag} takes a number; got "${value}"`);
  if (types.has('boolean')) throw new CliUsageError(`--${flag} takes true or false; got "${value}"`);
  throw new CliUsageError(`--${flag} takes JSON (${[...types].join(' or ')}); got "${value}"`);
}

/**
 * The command's input from its field flags, on top of `base` (what `--input` gave). A dotted name sets a
 * nested field (`--auth.type bearer`); a field given again is appended when it is an array, refused otherwise.
 * An unknown name is refused, so a typo is not dropped quietly.
 */
export function fieldsToInput(fields: CliField[], schema: JsonSchema | undefined, base: Record<string, unknown> = {}, command = 'the command'): Record<string, unknown> {
  const input: Record<string, unknown> = structuredClone(base);
  const given = new Set<string>();
  for (const field of fields) {
    const parts = field.name.split('.');
    let target = input;
    let level: JsonSchema | undefined = schema;
    const path: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const resolved = resolveFieldName(parts[i], level);
      if (!resolved) throw new CliUsageError(`Unknown field --${field.name} for ${command}; quiver describe ${command} lists its fields`);
      const object = objectSchema(level);
      const propSchema: JsonSchema | undefined = object?.properties?.[resolved.key] ?? (typeof object?.additionalProperties === 'object' ? object.additionalProperties : undefined);
      path.push(resolved.key);
      if (i < parts.length - 1) {
        const types = schemaTypes(propSchema);
        if (types.size && !types.has('object')) throw new CliUsageError(`--${field.name}: ${path.join('.')} is a ${typeLabel(propSchema)}, not an object`);
        const existing = target[resolved.key];
        if (existing === undefined || existing === null) target[resolved.key] = {};
        else if (typeof existing !== 'object' || Array.isArray(existing)) throw new CliUsageError(`--${field.name}: ${path.join('.')} is not an object`);
        target = target[resolved.key] as Record<string, unknown>;
        level = propSchema;
        continue;
      }
      const key = path.join('.');
      let value = coerceValue(resolved.negate ? 'false' : field.value, propSchema, field.name);
      if (resolved.negate) value = false;
      const types = schemaTypes(propSchema);
      if (given.has(key)) {
        if (!types.has('array') || !Array.isArray(target[resolved.key])) throw new CliUsageError(`--${field.name} is given twice`);
        target[resolved.key] = [...(target[resolved.key] as unknown[]), ...(Array.isArray(value) ? value : [value])];
      } else target[resolved.key] = value;
      given.add(key);
    }
  }
  return input;
}

// ---------- describe ----------

/** A short name for a schema's type: `string`, `number`, `a | b`, `string[]`, `string | null`. */
export function typeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return 'any';
  if (schema.enum?.length) return schema.enum.map((v) => (v === null ? 'null' : String(v))).join(' | ');
  if ('const' in schema) return JSON.stringify(schema.const);
  const members = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (members.length) return [...new Set(members.map(typeLabel))].join(' | ');
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
  if (type === 'array') return `${typeLabel(schema.items)}[]`;
  return type ?? 'any';
}

export interface CliFieldRow {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/** The top-level fields of a command's input, required ones first, for `quiver describe`. */
export function fieldRows(schema: JsonSchema | undefined): CliFieldRow[] {
  const required = new Set(schema?.required ?? []);
  const rows = Object.entries(schema?.properties ?? {}).map(([name, prop]) => ({ name, type: typeLabel(prop), required: required.has(name), ...(prop.description ? { description: prop.description } : {}) }));
  return [...rows.filter((r) => r.required), ...rows.filter((r) => !r.required)];
}

function sampleValue(schema: JsonSchema | undefined): unknown {
  if (!schema) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if ('const' in schema) return schema.const;
  const members = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter((m) => !schemaTypes(m).has('null') || schemaTypes(m).size > 1);
  if (members.length) return sampleValue(members[0]);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = sampleValue(schema.properties?.[key]);
      return out;
    }
    default:
      return null;
  }
}

/** A command line and an `--input` object with the required fields, for `quiver describe`. */
export function exampleFor(command: string, schema: JsonSchema | undefined): { args: string[]; input: Record<string, unknown> } {
  const args = ['quiver', command];
  const input: Record<string, unknown> = {};
  for (const key of schema?.required ?? []) {
    const prop = schema?.properties?.[key];
    input[key] = sampleValue(prop);
    const types = schemaTypes(prop);
    if (types.has('boolean') && types.size === 1) args.push(`--${key}`);
    else if (prop?.enum?.length) args.push(`--${key}`, String(prop.enum[0]));
    else if (types.has('object') || (types.has('array') && !types.has('string'))) args.push(`--${key}`, `'${JSON.stringify(input[key])}'`);
    else args.push(`--${key}`, `<${typeLabel(prop)}>`);
  }
  return { args, input };
}

// ---------- results ----------

/**
 * How many failed checks a result reports: a collection run's failed requests (and a run that ended
 * failed), or a sent response's failed checks. Zero for any other result. A non-zero count is exit code 4.
 */
export function resultFailures(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const r = result as { items?: unknown; failed?: unknown; status?: unknown; checks?: unknown };
  // A run that failed or was cancelled before the end fails as a whole, even with no failed request.
  if (Array.isArray(r.items) && typeof r.failed === 'number') return Math.max(r.failed, r.status === 'failed' || r.status === 'cancelled' ? 1 : 0);
  if (Array.isArray(r.checks)) return r.checks.filter((c) => c && typeof c === 'object' && (c as { ok?: unknown }).ok === false).length;
  return 0;
}

/** The exit code for an error the host answered with: refused input and unknown commands are usage errors. */
export function exitCodeForError(code: string): number {
  return code === 'INVALID_INPUT' || code === 'UNKNOWN_COMMAND' ? CLI_EXIT.usage : CLI_EXIT.failed;
}

// ---------- secrets for headless runs ----------

/** The environment variable a headless run reads the secret `name` from: `api.token` is QUIVER_SECRET_API_TOKEN. */
export function secretEnvName(name: string): string {
  return `QUIVER_SECRET_${name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

/**
 * A secret handed to a headless run, by name: the `--secrets` file (the exact name, then any key with the
 * same environment variable name) wins over a `QUIVER_SECRET_<NAME>` variable. Undefined when neither has it.
 */
export function lookupSecret(name: string, env: Record<string, string | undefined>, file: Record<string, unknown> = {}): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (typeof file[trimmed] === 'string') return file[trimmed] as string;
  const envName = secretEnvName(trimmed);
  for (const [key, value] of Object.entries(file)) if (typeof value === 'string' && secretEnvName(key) === envName) return value;
  return env[envName];
}

// ---------- where things are ----------

/**
 * The folder the OS keeps application data in, as Electron's `appData`: `%APPDATA%` on Windows,
 * `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` or `~/.config` elsewhere.
 */
export function appDataFolder(platform: string, env: Record<string, string | undefined>, home: string): string {
  const join = (...parts: string[]) => parts.join(platform === 'win32' ? '\\' : '/');
  if (platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

/** How to put the shim folder on PATH, one copyable line per shell. Nothing runs it for the user. */
export function cliPathLines(platform: string, folder: string): { shell: string; line: string }[] {
  if (platform === 'win32') {
    const quoted = folder.replace(/'/g, "''");
    return [
      { shell: 'PowerShell', line: `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${quoted}', 'User')` },
      { shell: 'This terminal only', line: `$env:Path += ';${quoted}'` },
    ];
  }
  const quoted = `"${folder.replace(/(["\\$`])/g, '\\$1')}"`;
  const rc = platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
  return [
    { shell: platform === 'darwin' ? 'zsh' : 'bash', line: `echo 'export PATH="$PATH:'${quoted}'"' >> ${rc}` },
    { shell: 'Symlink', line: `sudo ln -sf ${quoted}/quiver /usr/local/bin/quiver` },
  ];
}
