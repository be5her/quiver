import { z } from 'zod';

/**
 * Dotenv files: a parser that keeps every byte it does not understand, so a file can be
 * edited key by key without losing comments, blank lines or the author's quoting.
 * The value semantics follow the `dotenv` npm package: `export` prefixes, `KEY: value`,
 * unquoted values trimmed and cut at the first `#`, double quotes with `\n` `\r` `\t` `\"`
 * escapes, single quotes and backticks literal, quoted values spanning several lines,
 * and the last occurrence of a duplicated key wins.
 */

export type DotenvQuote = '"' | "'" | '`' | null;

export interface DotenvLine {
  /** 1-based line number of the first physical line. */
  line: number;
  kind: 'blank' | 'comment' | 'pair' | 'invalid';
  /** The physical lines as read, without line terminators. */
  raw: string[];
  key?: string;
  value?: string;
  quote?: DotenvQuote;
  exported?: boolean;
  /** Text of a trailing `# comment` on a pair line, without the hash. */
  comment?: string | null;
}

export interface DotenvDocument {
  lines: DotenvLine[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

export interface DotenvEntry {
  key: string;
  value: string;
  line: number;
  quote: DotenvQuote;
  exported: boolean;
  comment: string | null;
  /** The key looks like a credential; the UI masks it and agents get `••••••••` unless they reveal. */
  secret: boolean;
  /** An earlier occurrence of a key that appears again later (the later one wins). */
  shadowed: boolean;
  /** The value references another variable (`${OTHER}` or `$OTHER`), as dotenv-expand would resolve. */
  interpolates: boolean;
}

export const ENV_MASK = '••••••••';

const PAIR = /^(\s*)(export\s+)?([\w.-]+)(\s*=\s*|\s*:\s+)(.*)$/;
const SECRET_KEY = /(secret|passw(or)?d|pwd|token|api[_-]?key|private|credential|auth|signing|salt|dsn|connection[_-]?str|access[_-]?key|client[_-]?id|license|cookie|session[_-]?key|encryption|cipher|webhook[_-]?url)/i;
const SECRET_VALUE = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i;
const INTERPOLATION = /(^|[^\\])\$(\{[\w.-]+(:-[^}]*)?\}|[A-Za-z_][\w]*)/;

export function isSecretKey(key: string, value = ''): boolean {
  return SECRET_KEY.test(key) || SECRET_VALUE.test(value);
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(.)/gs, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

export function parseDotenv(text: string): DotenvDocument {
  const eol: DotenvDocument['eol'] = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith('\n');
  const physical = text.split(/\r?\n/);
  if (trailingNewline) physical.pop();
  const lines: DotenvLine[] = [];
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    const number = i + 1;
    if (!raw.trim()) {
      lines.push({ line: number, kind: 'blank', raw: [raw] });
      continue;
    }
    if (raw.trimStart().startsWith('#')) {
      lines.push({ line: number, kind: 'comment', raw: [raw] });
      continue;
    }
    const m = PAIR.exec(raw);
    if (!m) {
      lines.push({ line: number, kind: 'invalid', raw: [raw] });
      continue;
    }
    const key = m[3];
    const exported = Boolean(m[2]);
    let rest = m[5];
    const quote = (rest[0] === '"' || rest[0] === "'" || rest[0] === '`' ? rest[0] : null) as DotenvQuote;
    if (quote) {
      // Find the closing quote, possibly on a later physical line.
      const rawLines = [raw];
      let body = rest.slice(1);
      let closeAt = findClose(body, quote);
      let j = i;
      while (closeAt < 0 && j + 1 < physical.length) {
        j++;
        rawLines.push(physical[j]);
        body += `\n${physical[j]}`;
        closeAt = findClose(body, quote);
      }
      if (closeAt < 0) {
        // Never closed: dotenv treats the rest of the first line as an unquoted value.
        const unquoted = cutComment(rest);
        lines.push({ line: number, kind: 'pair', raw: [raw], key, value: unquoted.value, quote: null, exported, comment: unquoted.comment });
        continue;
      }
      const inner = body.slice(0, closeAt);
      const after = body.slice(closeAt + 1).trim();
      const comment = after.startsWith('#') ? after.slice(1).trim() : null;
      const value = quote === '"' ? unescapeDouble(inner) : inner;
      lines.push({ line: number, kind: 'pair', raw: rawLines, key, value, quote, exported, comment });
      i = j;
      continue;
    }
    const unquoted = cutComment(rest);
    lines.push({ line: number, kind: 'pair', raw: [raw], key, value: unquoted.value, quote: null, exported, comment: unquoted.comment });
  }
  return { lines, eol, trailingNewline };
}

function findClose(body: string, quote: NonNullable<DotenvQuote>): number {
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '\\' && quote === '"') {
      k++;
      continue;
    }
    if (c === quote) return k;
  }
  return -1;
}

function cutComment(rest: string): { value: string; comment: string | null } {
  const hash = rest.indexOf('#');
  if (hash < 0) return { value: rest.trim(), comment: null };
  return { value: rest.slice(0, hash).trim(), comment: rest.slice(hash + 1).trim() };
}

export function serializeDotenv(doc: DotenvDocument): string {
  const out = doc.lines.map((l) => l.raw.join(doc.eol)).join(doc.eol);
  return doc.lines.length && doc.trailingNewline ? out + doc.eol : out;
}

/** The effective entries of a document, in file order, with duplicates flagged. */
export function dotenvEntries(doc: DotenvDocument): DotenvEntry[] {
  const pairs = doc.lines.filter((l) => l.kind === 'pair');
  const lastIndex = new Map<string, number>();
  pairs.forEach((p, i) => lastIndex.set(p.key!, i));
  return pairs.map((p, i) => ({
    key: p.key!,
    value: p.value ?? '',
    line: p.line,
    quote: p.quote ?? null,
    exported: Boolean(p.exported),
    comment: p.comment ?? null,
    secret: isSecretKey(p.key!, p.value ?? ''),
    shadowed: lastIndex.get(p.key!) !== i,
    interpolates: p.quote !== "'" && p.quote !== '`' && INTERPOLATION.test(p.value ?? ''),
  }));
}

/** Key to effective value, as `dotenv.parse` would return it. */
export function dotenvToMap(doc: DotenvDocument): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of dotenvEntries(doc)) map[e.key] = e.value;
  return map;
}

const KEY = /^[\w.-]+$/;

export function isValidDotenvKey(key: string): boolean {
  return KEY.test(key);
}

/**
 * Quote a value the way a careful author would: bare when it is plain, double quotes with
 * escapes when it holds spaces, `#`, quotes, `=` or line breaks. `preferred` keeps the quote
 * style an existing line used when that style can still hold the value.
 */
export function quoteDotenvValue(value: string, preferred: DotenvQuote = null): string {
  if (value === '') return preferred ? `${preferred}${preferred}` : '';
  const plain = !/[\s#"'`\\$]/.test(value) && !value.includes('\n');
  if (plain && preferred !== '"' && preferred !== "'" && preferred !== '`') return value;
  if ((preferred === "'" || preferred === '`') && !value.includes(preferred) && !value.includes('\n')) return `${preferred}${value}${preferred}`;
  if (preferred === null && plain) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function pairLine(key: string, value: string, options: { quote?: DotenvQuote; exported?: boolean; comment?: string | null; indent?: string } = {}): string {
  const head = `${options.indent ?? ''}${options.exported ? 'export ' : ''}${key}=${quoteDotenvValue(value, options.quote ?? null)}`;
  return options.comment ? `${head} # ${options.comment}` : head;
}

/**
 * Set a key, rewriting only the line that carries its effective value (the last occurrence)
 * or appending one. Returns a new document.
 */
export function setDotenvValue(doc: DotenvDocument, key: string, value: string, options: { comment?: string | null } = {}): DotenvDocument {
  if (!isValidDotenvKey(key)) throw new Error(`Invalid key "${key}": letters, digits, _ . - only`);
  const lines = doc.lines.map((l) => ({ ...l, raw: [...l.raw] }));
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === 'pair' && lines[i].key === key) {
      index = i;
      break;
    }
  }
  if (index >= 0) {
    const current = lines[index];
    const indent = /^\s*/.exec(current.raw[0])?.[0] ?? '';
    const comment = options.comment === undefined ? current.comment ?? null : options.comment;
    const raw = pairLine(key, value, { quote: current.quote ?? null, exported: current.exported, comment, indent });
    lines[index] = { ...current, raw: raw.split('\n'), value, comment, quote: quoteOf(raw.slice(indent.length + (current.exported ? 7 : 0) + key.length + 1)) };
    return { ...doc, lines, trailingNewline: doc.trailingNewline || lines.length === 0 };
  }
  const raw = pairLine(key, value, { comment: options.comment ?? null });
  const line = (lines.at(-1)?.line ?? 0) + (lines.at(-1)?.raw.length ?? 1);
  lines.push({ line, kind: 'pair', raw: [raw], key, value, quote: quoteOf(raw.slice(key.length + 1)), exported: false, comment: options.comment ?? null });
  return { ...doc, lines, trailingNewline: true };
}

function quoteOf(text: string): DotenvQuote {
  const c = text[0];
  return c === '"' || c === "'" || c === '`' ? c : null;
}

/** Remove every occurrence of a key. Returns a new document and whether anything was removed. */
export function removeDotenvKey(doc: DotenvDocument, key: string): { doc: DotenvDocument; removed: boolean } {
  const lines = doc.lines.filter((l) => !(l.kind === 'pair' && l.key === key));
  return { doc: { ...doc, lines }, removed: lines.length !== doc.lines.length };
}

/** Append a comment line (and a blank line before it when the file does not end with one). */
export function appendDotenvComment(doc: DotenvDocument, comment: string): DotenvDocument {
  const lines = [...doc.lines];
  const last = lines.at(-1);
  const nextLine = (last?.line ?? 0) + (last?.raw.length ?? 1);
  if (last && last.kind !== 'blank') lines.push({ line: nextLine, kind: 'blank', raw: [''] });
  lines.push({ line: nextLine + (last && last.kind !== 'blank' ? 1 : 0), kind: 'comment', raw: [`# ${comment}`] });
  return { ...doc, lines, trailingNewline: true };
}

/** Replace secret values by the mask, keeping the rest of the file byte for byte. */
export function maskDotenv(doc: DotenvDocument): DotenvDocument {
  let out = doc;
  for (const e of dotenvEntries(doc)) {
    if (!e.secret || !e.value) continue;
    out = { ...out, lines: out.lines.map((l) => (l.kind === 'pair' && l.key === e.key ? { ...l, raw: [pairLine(l.key, ENV_MASK, { quote: l.quote ?? null, exported: l.exported, comment: l.comment, indent: /^\s*/.exec(l.raw[0])?.[0] })], value: ENV_MASK } : l)) };
  }
  return out;
}

export function maskEntries(entries: DotenvEntry[]): DotenvEntry[] {
  return entries.map((e) => (e.secret && e.value ? { ...e, value: ENV_MASK } : e));
}

/** Build a whole file from key/value pairs, one per line, with a header comment. */
export function buildDotenv(pairs: { key: string; value: string; comment?: string | null }[], header?: string, eol: DotenvDocument['eol'] = '\n'): string {
  const lines = header ? header.split('\n').map((h) => `# ${h}`) : [];
  for (const p of pairs) lines.push(pairLine(p.key, p.value, { comment: p.comment ?? null }));
  return lines.length ? lines.join(eol) + eol : '';
}

// ---------- files ----------

export type EnvFileKind = 'main' | 'example' | 'local' | 'profile' | 'other';

export const ENV_EXAMPLE_SUFFIXES = ['example', 'sample', 'template', 'dist', 'defaults', 'default', 'schema', 'tpl'] as const;

export interface EnvFileName {
  kind: EnvFileKind;
  /** For `.env.<name>` files that are not examples or local overrides: the profile name. */
  profile: string | null;
}

/** Is this file name a dotenv file? `.env`, `.env.*`, `*.env`. */
export function isEnvFileName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || (name.endsWith('.env') && name.length > 4);
}

export function classifyEnvFile(name: string): EnvFileName {
  if (name === '.env') return { kind: 'main', profile: null };
  if (name.startsWith('.env.')) {
    const rest = name.slice(5);
    const parts = rest.split('.');
    if ((ENV_EXAMPLE_SUFFIXES as readonly string[]).includes(parts.at(-1)!)) return { kind: 'example', profile: null };
    if (parts.at(-1) === 'local') return { kind: 'local', profile: parts.length > 1 ? parts.slice(0, -1).join('.') : null };
    return { kind: 'profile', profile: rest };
  }
  return { kind: 'other', profile: null };
}

export function envKindLabel(kind: EnvFileKind, profile: string | null): string | null {
  if (kind === 'example') return 'example';
  if (kind === 'local') return profile ? `${profile} · local` : 'local';
  if (kind === 'profile') return profile;
  return null;
}

export interface EnvGitStatus {
  tracked: boolean;
  ignored: boolean;
}

export interface EnvFileSummary {
  /** Path relative to the project folder, with forward slashes. */
  path: string;
  dir: string;
  name: string;
  kind: EnvFileKind;
  profile: string | null;
  size: number;
  modifiedAt: string;
  keys: number;
  secrets: number;
  /** Keys whose value is empty. */
  empty: number;
  invalid: number;
  /** null when the project is not a git repository or git is not installed. */
  git: EnvGitStatus | null;
  /** `tracked`: a file with real values is committed; `unignored`: it would be committed on the next `git add .`. */
  warning: 'tracked' | 'unignored' | null;
}

export interface EnvFileContent extends EnvFileSummary {
  text: string;
  entries: DotenvEntry[];
  /** True when secret values were replaced by the mask (agents without reveal). */
  masked: boolean;
  eol: DotenvDocument['eol'];
}

export interface EnvDiff {
  path: string;
  against: string;
  /** Keys in `against` that `path` lacks. */
  missing: string[];
  /** Keys in `path` that `against` lacks. */
  extra: string[];
  /** Keys present in both but empty in `path`. */
  empty: string[];
  /** Keys present in both with different values. */
  different: string[];
  same: string[];
}

export function diffDotenv(path: string, a: DotenvEntry[], against: string, b: DotenvEntry[]): EnvDiff {
  const mapA = new Map(a.filter((e) => !e.shadowed).map((e) => [e.key, e.value]));
  const mapB = new Map(b.filter((e) => !e.shadowed).map((e) => [e.key, e.value]));
  const out: EnvDiff = { path, against, missing: [], extra: [], empty: [], different: [], same: [] };
  for (const key of mapB.keys()) if (!mapA.has(key)) out.missing.push(key);
  for (const [key, value] of mapA) {
    if (!mapB.has(key)) {
      out.extra.push(key);
      continue;
    }
    if (value === '') out.empty.push(key);
    else if (value === mapB.get(key)) out.same.push(key);
    else out.different.push(key);
  }
  return out;
}

export interface EnvProfile {
  name: string;
  path: string;
  /** The `.env` of the folder has exactly this file's content. */
  active: boolean;
}

export interface EnvProfileGroup {
  dir: string;
  /** Path of the folder's `.env`, or null when there is none yet. */
  main: string | null;
  profiles: EnvProfile[];
}

export interface EnvBackup {
  id: string;
  at: string;
  size: number;
  /** What caused the backup: the command that was about to change the file. */
  reason: string;
}

export const EnvSetEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string().default(''),
  /** Trailing `# comment`; omit to keep the existing one, empty string to drop it. */
  comment: z.string().nullable().optional(),
});
export type EnvSetEntry = z.infer<typeof EnvSetEntrySchema>;

/** Normalise a project-relative path: forward slashes, no leading `./`. */
export function normalizeEnvPath(p: string): string {
  let out = p.replace(/\\/g, '/').trim();
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/\/+/g, '/').replace(/^\/+/, '');
}

export function envPathDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function envPathName(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

const KIND_ORDER: Record<EnvFileKind, number> = { main: 0, local: 1, profile: 2, example: 3, other: 4 };

export function compareEnvFiles(a: Pick<EnvFileSummary, 'dir' | 'kind' | 'name'>, b: Pick<EnvFileSummary, 'dir' | 'kind' | 'name'>): number {
  if (a.dir !== b.dir) return a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir);
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name);
}
