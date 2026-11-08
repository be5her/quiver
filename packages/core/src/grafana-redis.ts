import { QuiverError } from './errors';
import type { GrafanaFrame } from './models/logs';
import type { RedisInfo } from './models/db';

/**
 * Redis through Grafana's Redis data source (`redis-datasource`). Its CLI mode takes one command
 * line, splits it the way a POSIX shell does (creachadair/shell: whitespace separates, single quotes
 * keep everything literally, line breaks included), runs it, and answers with the reply formatted as
 * redis-cli prints it, aligned by Go's tabwriter, in one string field named `Value`. This file turns
 * argument lists into such lines and those replies back into values.
 */

/** The plugin's type id in Grafana. */
export const GRAFANA_REDIS_TYPE = 'redis-datasource';

/** A Redis data source as Grafana lists it to the signed-in user (`/api/frontend/settings`). */
export interface GrafanaRedisDatasource {
  uid: string;
  name: string;
  /** The admin turned off the plugin's CLI; Quiver then only reads, through the plugin's fixed commands. */
  cliDisabled: boolean;
}

/** A reply as the CLI prints it: a string, an integer, nil or an array of those. */
export type RedisCliValue = string | number | null | RedisCliValue[];

/** Characters that make creachadair/shell's Quote quote a word. */
const NEEDS_QUOTES = /[|&;<>()$`\\"\t\n*?[#~=% ']/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** One argument as the plugin's shell splitter reads it back unchanged: bare when safe, else in single quotes. */
export function quoteRedisCliArg(arg: string): string {
  if (arg === '') return "''";
  if (!NEEDS_QUOTES.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line for an argument list. Every string survives the plugin's splitter in single quotes,
 * spaces, quotes and line breaks included; a lone UTF-16 surrogate does not survive the trip through
 * Grafana's JSON (it turns into U+FFFD), so such an argument is refused instead of being sent altered.
 */
export function redisCliLine(argv: readonly string[]): string {
  if (!argv.length || !argv[0]) throw new QuiverError('INVALID_INPUT', 'Enter a Redis command, e.g. GET mykey');
  argv.forEach((arg, i) => {
    if (LONE_SURROGATE.test(arg)) {
      throw new QuiverError('INVALID_INPUT', `Argument ${i + 1} of ${argv[0]} holds a lone UTF-16 surrogate, which Grafana would replace with U+FFFD; it cannot be sent through a Grafana data source unchanged.`, { argument: i });
    }
  });
  return argv.map(quoteRedisCliArg).join(' ');
}

/**
 * creachadair/shell's Split, as the plugin runs it on the command line: null when a quote is left open.
 * Outside quotes a backslash keeps the next character; inside double quotes it only escapes `$`, `` ` ``, `"`,
 * `\` and a line break.
 */
export function splitRedisCliLine(line: string): string[] | null {
  type State = 'break' | 'breakQ' | 'word' | 'wordQ' | 'single' | 'double' | 'doubleQ';
  const out: string[] = [];
  let state: State = 'break';
  let cur = '';
  for (const c of line) {
    const cls = c === ' ' || c === '\t' ? 'space' : c === '\n' ? 'nl' : c === '\\' ? 'bs' : c === "'" ? 'single' : c === '"' ? 'double' : 'other';
    switch (state) {
      case 'break':
        if (cls === 'space' || cls === 'nl') break;
        if (cls === 'bs') state = 'breakQ';
        else if (cls === 'single') state = 'single';
        else if (cls === 'double') state = 'double';
        else {
          state = 'word';
          cur += c;
        }
        break;
      case 'breakQ':
        state = cls === 'nl' ? 'break' : 'word';
        if (cls !== 'nl') cur += c;
        break;
      case 'word':
        if (cls === 'space' || cls === 'nl') {
          out.push(cur);
          cur = '';
          state = 'break';
        } else if (cls === 'bs') state = 'wordQ';
        else if (cls === 'single') state = 'single';
        else if (cls === 'double') state = 'double';
        else cur += c;
        break;
      case 'wordQ':
        state = 'word';
        if (cls !== 'nl') cur += c;
        break;
      case 'single':
        if (cls === 'single') state = 'word';
        else cur += c;
        break;
      case 'double':
        if (cls === 'bs') state = 'doubleQ';
        else if (cls === 'double') state = 'word';
        else cur += c;
        break;
      case 'doubleQ':
        state = 'double';
        if (cls === 'nl') break;
        cur += cls === 'bs' || cls === 'double' ? c : `\\${c}`;
        break;
    }
  }
  if (state === 'word') out.push(cur);
  return state === 'break' || state === 'word' ? out : null;
}

// ---------- the CLI's reply text ----------

/** The plugin's convertToCLI: redis-cli's layout, with a tab after each `n)` for the tabwriter to align. */
function toCli(value: RedisCliValue, tabs: string): string {
  if (typeof value === 'number') return `(integer) ${value}\n`;
  if (typeof value === 'string') return `"${value}"\n`;
  if (value === null) return '(nil)\n';
  if (!value.length) return '(empty array)\n';
  return value.map((member, i) => `${i === 0 ? '' : tabs}${i + 1})\t ${toCli(member, `${tabs}\t`)}`).join('');
}

const runes = (s: string) => [...s].length;

/** Go's text/tabwriter with the plugin's settings: no minimum width or padding, spaces, cells aligned right. */
function tabwrite(text: string): string {
  const lines = text.split('\n').map((l) => l.split('\t'));
  let out = '';
  const write = (widths: number[], from: number, to: number) => {
    for (let i = from; i < to; i++) {
      lines[i]!.forEach((cell, j) => {
        if (j < widths.length) out += ' '.repeat(Math.max(0, widths[j]! - runes(cell)));
        out += cell;
      });
      if (i + 1 < lines.length) out += '\n';
    }
  };
  const format = (widths: number[], line0: number, line1: number) => {
    const column = widths.length;
    for (let at = line0; at < line1; at++) {
      if (column >= lines[at]!.length - 1) continue;
      write(widths, line0, at);
      line0 = at;
      let width = 0;
      for (; at < line1; at++) {
        const line = lines[at]!;
        if (column >= line.length - 1) break;
        width = Math.max(width, runes(line[column]!));
      }
      format([...widths, width], line0, at);
      line0 = at;
    }
    write(widths, line0, line1);
  };
  format([], 0, lines.length);
  return out;
}

/** A reply as the plugin's CLI mode prints it. The smoke's fake Grafana answers with this; tests check the parser against it. */
export function formatRedisCliReply(value: RedisCliValue): string {
  return tabwrite(toCli(value, ''));
}

const SCALAR = /^(?:"|\(integer\) -?\d+$|\(nil\)$|\(empty array\)$)/;

function scalar(text: string): RedisCliValue {
  if (text === '(nil)') return null;
  if (text === '(empty array)') return [];
  const int = /^\(integer\) (-?\d+)$/.exec(text);
  if (int) return Number(int[1]);
  return text;
}

function unparsable(text: string, why: string): QuiverError {
  return new QuiverError('REQUEST_FAILED', `Could not read the reply of Grafana's Redis CLI (${why}): ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
}

/**
 * The value behind a CLI reply. A string is everything between its quotes, so quotes and line
 * breaks inside it come through. Two things cannot: the tabwriter swallows tab characters inside
 * values, and an array element whose continuation line looks like the next `n) ` would be taken
 * for one.
 */
export function parseRedisCliReply(text: string): RedisCliValue {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.startsWith('"')) {
    if (body.length < 2 || !body.endsWith('"')) throw unparsable(text, 'an unterminated string');
    return body.slice(1, -1);
  }
  if (!/^\s*\d+\) /.test(body)) {
    if (!SCALAR.test(body)) throw unparsable(text, 'an unknown reply');
    return scalar(body);
  }

  interface Frame {
    items: RedisCliValue[];
    /** Column just past the `)` of this array's markers; the tabwriter keeps it the same for every element. */
    end: number;
  }
  const root: Frame = { items: [], end: -1 };
  let stack: Frame[] = [];
  /** The string still being read: where it sits and its text so far, closing quote included. */
  let open: { items: RedisCliValue[]; index: number; raw: string } | null = null;
  const close = () => {
    if (!open) return;
    if (!open.raw.endsWith('"')) throw unparsable(text, 'an unterminated string');
    open.items[open.index] = open.raw.slice(0, -1);
    open = null;
  };
  const marker = /^( *)(\d+)\)/;
  for (const line of body.split('\n')) {
    const markers: { n: number; end: number }[] = [];
    let pos = 0;
    let rest = line;
    for (;;) {
      const m = marker.exec(rest);
      if (!m || (markers.length > 0 && m[1] === '')) break;
      pos += m[0].length;
      markers.push({ n: Number(m[2]), end: pos });
      rest = rest.slice(m[0].length);
    }
    const value = rest.startsWith(' ') ? rest.slice(1) : null;
    if (!markers.length || value === null || !SCALAR.test(value)) {
      // A line of a string that spans several.
      if (!open) throw unparsable(text, 'an unexpected line');
      open.raw += `\n${line}`;
      continue;
    }
    close();
    const first = markers[0]!;
    let depth: number;
    if (!stack.length) {
      if (first.n !== 1) throw unparsable(text, 'an array not starting at 1');
      root.end = first.end;
      stack = [root];
      depth = 0;
    } else {
      // The array whose markers end in this column; when a string spanning lines broke the tabwriter's
      // alignment, the deepest one this element number continues.
      const fits = (d: number) => stack[d]!.items.length === first.n - 1;
      depth = -1;
      for (let d = stack.length - 1; d >= 0 && depth < 0; d--) if (stack[d]!.end === first.end && fits(d)) depth = d;
      for (let d = stack.length - 1; d >= 0 && depth < 0; d--) if (fits(d)) depth = d;
      if (depth < 0) throw unparsable(text, `element ${first.n} out of place`);
      stack = stack.slice(0, depth + 1);
    }
    let frame = stack[depth]!;
    if (frame.items.length !== first.n - 1) throw unparsable(text, `element ${first.n} out of place`);
    for (const nested of markers.slice(1)) {
      if (nested.n !== 1) throw unparsable(text, 'a nested array not starting at 1');
      const child: Frame = { items: [], end: nested.end };
      frame.items.push(child.items);
      stack.push(child);
      frame = child;
    }
    if (value.startsWith('"')) {
      frame.items.push(null);
      open = { items: frame.items, index: frame.items.length - 1, raw: value.slice(1) };
    } else {
      frame.items.push(scalar(value));
    }
  }
  close();
  return root.items;
}

/** The CLI reply in the frames of one query: one frame, one string field `Value`, one row. */
export function redisCliTextFromFrames(frames: readonly GrafanaFrame[] | undefined): string {
  const frame = frames?.[0];
  const at = frame?.schema?.fields?.findIndex((f) => f.name === 'Value') ?? -1;
  const cell = at >= 0 ? frame?.data?.values?.[at]?.[0] : undefined;
  if (typeof cell !== 'string') throw new QuiverError('REQUEST_FAILED', 'Grafana answered without the CLI reply (expected one Value field); is this a Redis data source with CLI mode?');
  return cell;
}

/** A frame's columns by field name, for the plugin's fixed (non-CLI) commands. */
export function grafanaFrameColumns(frame: GrafanaFrame | undefined): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  (frame?.schema?.fields ?? []).forEach((f, i) => out.set(f.name, frame?.data?.values?.[i] ?? []));
  return out;
}

// ---------- what a shared connection pool cannot do ----------

/** Commands that change or depend on the state of one connection. */
const CONNECTION_STATE = new Set([
  'SELECT',
  'AUTH',
  'HELLO',
  'RESET',
  'QUIT',
  'MULTI',
  'EXEC',
  'DISCARD',
  'WATCH',
  'UNWATCH',
  'SUBSCRIBE',
  'PSUBSCRIBE',
  'SSUBSCRIBE',
  'UNSUBSCRIBE',
  'PUNSUBSCRIBE',
  'SUNSUBSCRIBE',
  'MONITOR',
  'SYNC',
  'PSYNC',
  'READONLY',
  'READWRITE',
]);
const CLIENT_STATE = new Set(['SETNAME', 'SETINFO', 'REPLY', 'TRACKING', 'CACHING', 'NO-EVICT', 'NO-TOUCH']);

/**
 * Why a command cannot go through a Grafana data source, or null. Grafana runs each query on any
 * connection of a pool it shares with every dashboard: SELECT or CLIENT SETNAME would change that
 * connection for whoever uses it next, MULTI and WATCH would not see their EXEC, and SUBSCRIBE or
 * MONITOR would keep it busy.
 */
export function grafanaRedisRefusal(argv: readonly string[]): string | null {
  const cmd = (argv[0] ?? '').toUpperCase();
  const sub = (argv[1] ?? '').toUpperCase();
  if (CONNECTION_STATE.has(cmd) || (cmd === 'CLIENT' && CLIENT_STATE.has(sub))) {
    const what = cmd === 'CLIENT' ? `CLIENT ${sub}` : cmd;
    return `${what} cannot run through Grafana: each command goes to any connection of a pool that Grafana shares with every dashboard, so per-connection state (database, name, transaction, subscription) would leak to other queries or be lost.${cmd === 'SELECT' ? ' The data source address picks the database.' : ''}`;
  }
  return null;
}

// ---------- INFO ----------

/** What the key browser's strip shows, from the text of `INFO` and the reply of `DBSIZE`. */
export function redisInfoFromText(text: string, keys: number | null): RedisInfo {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0 && !line.startsWith('#')) fields.set(line.slice(0, at), line.slice(at + 1));
  }
  const num = (key: string) => (fields.has(key) && fields.get(key) !== '' && Number.isFinite(Number(fields.get(key))) ? Number(fields.get(key)) : null);
  const str = (key: string) => fields.get(key) ?? null;
  const hits = num('keyspace_hits');
  const misses = num('keyspace_misses');
  return {
    version: str('redis_version'),
    mode: str('redis_mode'),
    uptimeSeconds: num('uptime_in_seconds'),
    connectedClients: num('connected_clients'),
    usedMemory: num('used_memory'),
    usedMemoryHuman: str('used_memory_human'),
    maxMemoryHuman: str('maxmemory_human'),
    keys,
    opsPerSecond: num('instantaneous_ops_per_sec'),
    hitRate: hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null,
    role: str('role'),
  };
}
