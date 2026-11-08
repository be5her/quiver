import { exampleFor, fieldRows, type ApiRun, type JsonSchema } from '@quiver/core';

export const USAGE = `quiver: run any Quiver command from a terminal or CI. See docs/cli.md.

Usage
  quiver list [module] [--all]          the commands (id, title, whether it changes data)
  quiver describe <command>             a command's fields, input schema and an example
  quiver <command> [fields]             run a command (quiver run <command> works too)

Fields
  --<field> <value>                     one field of the input; numbers, booleans and JSON are read
                                        as the command's schema says (quiver describe lists them)
  --<field>.<key> <value>               a nested field; a repeated array field adds an item
  --no-<field>                          a boolean field off
  --input '<json>' | @file.json | @-    the whole input; fields given as flags go on top

Options
  --workspace <folder>                  the project; defaults to the nearest folder up with a .quiver
  --json                                JSON output (the default when stdout is not a terminal)
  --quiet, -q                           print nothing on success
  --timeout <seconds>                   give up after this long (also 500ms, 2m)
  --headless                            run in this process, without the app (CI)
  --headless=auto                       connect to the app, or run headless when it is not running
  --data-dir <folder>                   headless: config and per-machine state (default: quiver-cli)
  --secrets <file.json>                 headless: secrets by name; QUIVER_SECRET_<NAME> works too
  --user-data-dir <folder>              connected: the app's user data folder, when it is not the default
  --reporter junit [--out <file>]       api.collection.run: a JUnit XML report
  --help, -h | --version

Exit codes
  0 ok · 1 the command failed (its error as JSON on stderr) · 2 bad usage or input
  3 Quiver not reachable · 4 the result reports failed checks
`;

/** Where the CLI writes, and in which form. Writes finish before the process exits, even into a pipe. */
export class Output {
  constructor(
    readonly json: boolean,
    readonly quiet: boolean,
  ) {}

  write(text: string, stream: NodeJS.WriteStream = process.stdout): Promise<void> {
    if (!text) return Promise.resolve();
    return new Promise((resolve) => stream.write(text.endsWith('\n') ? text : `${text}\n`, () => resolve()));
  }

  /** A result: JSON in JSON mode, text as it is otherwise, anything else indented. */
  result(value: unknown): Promise<void> {
    if (this.quiet) return Promise.resolve();
    if (!this.json && typeof value === 'string') return this.write(value);
    return this.write(JSON.stringify(value ?? null, null, 2));
  }

  error(error: unknown): Promise<void> {
    return this.write(JSON.stringify(error, null, 2), process.stderr);
  }

  usage(message: string): Promise<void> {
    return this.write(`quiver: ${message}\nRun quiver --help for the syntax.`, process.stderr);
  }
}

export interface CommandRow {
  id: string;
  module: string;
  title: string;
  scope: 'global' | 'workspace';
  mutating: boolean;
  conditional: boolean;
  hidden: boolean;
}

function changes(row: { mutating: boolean; conditional: boolean }): string {
  return row.conditional ? 'per call' : row.mutating ? 'mutating' : '';
}

export function formatList(rows: CommandRow[]): string {
  if (!rows.length) return 'No commands.';
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const titleWidth = Math.min(48, Math.max(...rows.map((r) => r.title.length)));
  return rows.map((r) => `${r.id.padEnd(idWidth)}  ${r.title.padEnd(titleWidth)}  ${changes(r)}${r.hidden ? ' hidden' : ''}`.trimEnd()).join('\n');
}

export interface Described extends CommandRow {
  description: string;
  input: JsonSchema;
}

export function formatDescribe(d: Described): string {
  const example = exampleFor(d.id, d.input);
  const rows = fieldRows(d.input);
  const lines = [`${d.id}: ${d.title}`, d.description, '', `Scope: ${d.scope === 'workspace' ? 'a workspace' : 'global'} · ${d.conditional ? 'changes data on some calls' : d.mutating ? 'changes data' : 'read-only'}`];
  if (rows.length) {
    const width = Math.max(...rows.map((r) => `--${r.name} <${r.type}>`.length));
    lines.push('', 'Fields');
    for (const r of rows) lines.push(`  ${`--${r.name} <${r.type}>`.padEnd(width)}  ${r.required ? 'required' : 'optional'}${r.description ? `  ${r.description}` : ''}`);
  } else lines.push('', 'No fields.');
  lines.push('', 'Example', `  ${example.args.join(' ')}`);
  if (rows.length) lines.push(`  quiver ${d.id} --input '${JSON.stringify(example.input)}'`);
  return lines.join('\n');
}

/** A finished collection run as a few readable lines. */
export function formatRun(run: ApiRun): string {
  const total = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0;
  const errors = run.items.filter((i) => i.status === 'error').length;
  const head = `${run.collectionName}: ${run.status}, ${run.passed} passed, ${run.failed} failed${errors ? ` (${errors} without a response)` : ''} in ${(total / 1000).toFixed(1)}s`;
  const lines = run.items.map((i) => {
    const line = `  ${i.status.toUpperCase().padEnd(9)} ${i.method.padEnd(6)} ${i.name}${i.httpStatus !== null ? `  ${i.httpStatus}` : ''}${i.durationMs !== null ? `  ${i.durationMs} ms` : ''}`;
    const why = [...(i.checks ?? []).filter((c) => !c.ok).map((c) => c.message), ...(i.error ? [i.error] : [])].map((m) => `            ${m}`);
    return [line, ...why].join('\n');
  });
  return [head, ...lines].join('\n');
}
