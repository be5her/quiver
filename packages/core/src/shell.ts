/**
 * Tokenizers for the shells a copied command line comes from: POSIX sh (bash, zsh), cmd.exe and
 * PowerShell. Each follows its shell's own quoting rules, so what comes out is the argv the
 * program would have received, and anything a shell would have expanded or treated as syntax is
 * an error rather than text that ends up in the result.
 */

export type ShellDialect = 'posix' | 'cmd' | 'powershell';

export const SHELL_DIALECTS: ShellDialect[] = ['posix', 'cmd', 'powershell'];

export const SHELL_DIALECT_LABELS: Record<ShellDialect, string> = {
  posix: 'bash/zsh',
  cmd: 'cmd.exe',
  powershell: 'PowerShell',
};

/** One argument and where it starts in the source, for error messages. */
export interface ShellToken {
  value: string;
  offset: number;
}

export class ShellSyntaxError extends Error {
  constructor(
    readonly dialect: ShellDialect,
    readonly offset: number,
    message: string,
    source: string,
  ) {
    super(`${SHELL_DIALECT_LABELS[dialect]}: ${message} at ${describePosition(source, offset)}`);
    this.name = 'ShellSyntaxError';
  }
}

/** "line 2, column 7", 1-based. */
export function describePosition(source: string, offset: number): string {
  const before = source.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return `line ${line}, column ${column}`;
}

/**
 * Guess the shell a command was written for. cmd.exe continues lines with a caret and Chrome wraps
 * every argument in ^"…^"; PowerShell continues lines with a backtick and calls curl as curl.exe
 * (plain curl is an alias of Invoke-WebRequest in Windows PowerShell). Anything else is POSIX.
 */
export function detectShellDialect(source: string): ShellDialect {
  const text = source.replace(/^﻿/, '').trimStart();
  if (/^(&\s*)?(["']?)curl\.exe\2(\s|$)/i.test(text) || /[ \t]`\r?\n/.test(text)) return 'powershell';
  if (/[ \t]\^\r?\n/.test(text) || /(^|\s)\^"/.test(text)) return 'cmd';
  return 'posix';
}

export function tokenizeShellDialect(source: string, dialect: ShellDialect): ShellToken[] {
  switch (dialect) {
    case 'posix':
      return tokenizePosix(source);
    case 'cmd':
      return tokenizeCmd(source);
    case 'powershell':
      return tokenizePowerShell(source);
  }
}

/** Length of the line break at `i` (1 for \n, 2 for \r\n), or 0. */
function lineBreakAt(s: string, i: number): number {
  if (s[i] === '\n') return 1;
  if (s[i] === '\r' && s[i + 1] === '\n') return 2;
  return 0;
}

const isBlank = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** Accumulates the current word; a word exists once any part of it (even an empty quote) is seen. */
class WordBuilder {
  readonly tokens: ShellToken[] = [];
  private value = '';
  private start = -1;

  get inWord(): boolean {
    return this.start >= 0;
  }

  add(text: string, offset: number): void {
    if (this.start < 0) this.start = offset;
    this.value += text;
  }

  end(): void {
    if (this.start >= 0) this.tokens.push({ value: this.value, offset: this.start });
    this.value = '';
    this.start = -1;
  }
}

// ---------- POSIX sh ----------

const ANSI_C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** Characters after `$` that make it an expansion rather than a literal dollar sign. */
const POSIX_EXPANSION = /[A-Za-z0-9_{(@*#?$!-]/;

/**
 * POSIX sh word splitting and quote removal: '…' is literal; "…" keeps \ only before $ ` " \ and
 * newline; $'…' is ANSI-C quoting; a backslash outside quotes escapes the next character and
 * backslash-newline continues the line. Expansions ($VAR, $(…), `…`) and control operators
 * (; & | < >) are refused, since what they stand for is not in the text.
 */
export function tokenizePosix(source: string): ShellToken[] {
  const fail = (offset: number, message: string) => new ShellSyntaxError('posix', offset, message, source);
  const words = new WordBuilder();
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      const br = lineBreakAt(source, i + 1);
      if (br) {
        i += 1 + br;
        continue;
      }
      if (i + 1 >= source.length) throw fail(i, 'a backslash at the end of the command escapes nothing');
      words.add(source[i + 1], i);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = source.indexOf("'", i + 1);
      if (close < 0) throw fail(i, "unterminated ' quote starting");
      words.add(source.slice(i + 1, close), i);
      i = close + 1;
      continue;
    }
    if (ch === '$' && source[i + 1] === "'") {
      i = readAnsiC(source, i, words, fail);
      continue;
    }
    if (ch === '"' || (ch === '$' && source[i + 1] === '"')) {
      i = readPosixDouble(source, ch === '$' ? i + 1 : i, words, fail);
      continue;
    }
    if (ch === '$' && POSIX_EXPANSION.test(source[i + 1] ?? '')) throw fail(i, 'the shell would expand this $ (quote it with \'…\' to keep it literal)');
    if (ch === '`') throw fail(i, 'command substitution with ` is not supported');
    if (ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>') throw fail(i, `unquoted ${ch} ends or redirects the command in the shell`);
    if (ch === '#' && !words.inWord) {
      // A comment runs to the end of the line.
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (isBlank(ch)) {
      // A bare line break would end the command in sh; it is read as a separator so commands
      // pasted without their trailing backslashes still import.
      words.end();
      i++;
      continue;
    }
    words.add(ch, i);
    i++;
  }
  words.end();
  return words.tokens;
}

function readPosixDouble(source: string, open: number, words: WordBuilder, fail: (o: number, m: string) => Error): number {
  words.add('', open);
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"') return i + 1;
    if (ch === '\\') {
      const next = source[i + 1];
      const br = lineBreakAt(source, i + 1);
      if (br) {
        i += 1 + br;
        continue;
      }
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        words.add(next, i);
        i += 2;
        continue;
      }
      words.add('\\', i);
      i++;
      continue;
    }
    if (ch === '$' && POSIX_EXPANSION.test(source[i + 1] ?? '')) throw fail(i, 'the shell would expand this $ inside "…" (escape it as \\$ or use \'…\')');
    if (ch === '`') throw fail(i, 'command substitution with ` inside "…" is not supported');
    words.add(ch, i);
    i++;
  }
  throw fail(open, 'unterminated " quote starting');
}

function readAnsiC(source: string, dollar: number, words: WordBuilder, fail: (o: number, m: string) => Error): number {
  words.add('', dollar);
  let i = dollar + 2;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'") return i + 1;
    if (ch !== '\\') {
      words.add(ch, i);
      i++;
      continue;
    }
    const next = source[i + 1];
    if (next === undefined) break;
    if (next in ANSI_C_ESCAPES) {
      words.add(ANSI_C_ESCAPES[next], i);
      i += 2;
      continue;
    }
    const numeric = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/.exec(source.slice(i + 1, i + 10));
    if (numeric) {
      const [whole, hex, u4, u8, oct] = numeric;
      const code = hex ? parseInt(hex, 16) : u4 ? parseInt(u4, 16) : u8 ? parseInt(u8, 16) : parseInt(oct, 8);
      if (code > 0x10ffff) throw fail(i, `\\${whole} is not a valid character`);
      words.add(String.fromCodePoint(code), i);
      i += 1 + whole.length;
      continue;
    }
    if (next === 'c' && source[i + 2] !== undefined) {
      words.add(String.fromCharCode(source.charCodeAt(i + 2) & 0x1f), i);
      i += 3;
      continue;
    }
    // bash keeps unknown escapes as they are.
    words.add(`\\${next}`, i);
    i += 2;
  }
  throw fail(dollar, "unterminated $' quote starting");
}

// ---------- cmd.exe ----------

/**
 * cmd.exe in the two layers Windows applies. First cmd itself: ^ makes the next character literal,
 * ^ at the end of a line joins the next line (whose first character is then literal too, which is
 * how ^ + line break + empty line encodes a line break), and inside "…" a ^ is plain text. Then
 * the program splits what cmd passes on with the MSVC rules (CommandLineToArgvW): whitespace
 * separates arguments outside "…", 2n backslashes before " give n backslashes and the " toggles
 * quoting, 2n+1 give n backslashes and a literal ", and other backslashes are literal.
 */
export function tokenizeCmd(source: string): ShellToken[] {
  const fail = (offset: number, message: string) => new ShellSyntaxError('cmd', offset, message, source);
  // Layer 1: cmd.exe. `offsets` maps each output character back to the source for errors.
  let line = '';
  const offsets: number[] = [];
  const emit = (ch: string, offset: number) => {
    line += ch;
    offsets.push(offset);
  };
  let quoted = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      emit(ch, i);
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      emit(ch, i);
      i++;
      continue;
    }
    if (ch === '^') {
      const br = lineBreakAt(source, i + 1);
      if (br) {
        const next = i + 1 + br;
        const second = lineBreakAt(source, next);
        if (second) {
          emit('\n', next);
          i = next + second;
        } else if (next < source.length) {
          emit(source[next], next);
          i = next + 1;
        } else {
          i = next;
        }
        continue;
      }
      if (i + 1 >= source.length) throw fail(i, 'a ^ at the end of the command escapes nothing');
      emit(source[i + 1], i);
      i += 2;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === '<' || ch === '>') throw fail(i, `unescaped ${ch} ends or redirects the command (escape it as ^${ch})`);
    emit(ch, i);
    i++;
  }

  // Layer 2: the MSVC argument parser.
  const words = new WordBuilder();
  let inQuotes = false;
  let quoteStart = -1;
  let j = 0;
  while (j < line.length) {
    const ch = line[j];
    if (ch === '\\') {
      let k = j;
      while (line[k] === '\\') k++;
      const count = k - j;
      if (line[k] === '"') {
        words.add('\\'.repeat(Math.floor(count / 2)), offsets[j]);
        if (count % 2 === 1) {
          words.add('"', offsets[k]);
        } else {
          inQuotes = !inQuotes;
          quoteStart = offsets[k];
        }
        j = k + 1;
      } else {
        words.add('\\'.repeat(count), offsets[j]);
        j = k;
      }
      continue;
    }
    if (ch === '"') {
      words.add('', offsets[j]);
      inQuotes = !inQuotes;
      quoteStart = offsets[j];
      j++;
      continue;
    }
    if (!inQuotes && isBlank(ch)) {
      words.end();
      j++;
      continue;
    }
    words.add(ch, offsets[j]);
    j++;
  }
  if (inQuotes) throw fail(quoteStart, 'unterminated quote (^" or ") starting');
  words.end();
  return words.tokens;
}

// ---------- PowerShell ----------

const PS_SINGLE = new Set(["'", '‘', '’', '‚', '‛']);
const PS_DOUBLE = new Set(['"', '“', '”', '„']);
const PS_ESCAPES: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const PS_EXPANSION = /[A-Za-z0-9_{(?$^]/;

/**
 * PowerShell argument mode: '…' is literal with '' for a quote; "…" takes backtick escapes
 * (`" `` `n `t `$ …) and "" for a quote; a backtick outside quotes makes the next character literal
 * and at the end of a line continues it. Typographic quotes count as quotes, as in PowerShell.
 * Variables, subexpressions and other syntax are refused.
 */
export function tokenizePowerShell(source: string): ShellToken[] {
  const fail = (offset: number, message: string) => new ShellSyntaxError('powershell', offset, message, source);
  const words = new WordBuilder();
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '`') {
      const br = lineBreakAt(source, i + 1);
      if (br) {
        i += 1 + br;
        continue;
      }
      if (i + 1 >= source.length) throw fail(i, 'a ` at the end of the command escapes nothing');
      words.add(source[i + 1], i);
      i += 2;
      continue;
    }
    if (PS_SINGLE.has(ch)) {
      words.add('', i);
      let k = i + 1;
      for (;;) {
        if (k >= source.length) throw fail(i, "unterminated ' quote starting");
        if (PS_SINGLE.has(source[k])) {
          if (PS_SINGLE.has(source[k + 1] ?? '')) {
            words.add("'", k);
            k += 2;
            continue;
          }
          break;
        }
        words.add(source[k], k);
        k++;
      }
      i = k + 1;
      continue;
    }
    if (PS_DOUBLE.has(ch)) {
      words.add('', i);
      let k = i + 1;
      for (;;) {
        if (k >= source.length) throw fail(i, 'unterminated " quote starting');
        const c = source[k];
        if (PS_DOUBLE.has(c)) {
          if (PS_DOUBLE.has(source[k + 1] ?? '')) {
            words.add('"', k);
            k += 2;
            continue;
          }
          break;
        }
        if (c === '`') {
          const next = source[k + 1];
          if (next === undefined) throw fail(i, 'unterminated " quote starting');
          words.add(PS_ESCAPES[next] ?? next, k);
          k += 2;
          continue;
        }
        if (c === '$' && PS_EXPANSION.test(source[k + 1] ?? '')) throw fail(k, 'PowerShell would expand this $ inside "…" (escape it as `$ or use \'…\')');
        words.add(c, k);
        k++;
      }
      i = k + 1;
      continue;
    }
    if (ch === '$' && PS_EXPANSION.test(source[i + 1] ?? '')) throw fail(i, "PowerShell would expand this $ (quote it with '…' to keep it literal)");
    if (ch === '-' && source.startsWith('--%', i) && !words.inWord && isBlank(source[i + 3] ?? ' ')) throw fail(i, 'the stop-parsing token --% is not supported');
    if (ch === '@' && !words.inWord) throw fail(i, 'splatting and @(…) are not supported');
    // The call operator in front of the program: & curl.exe …
    if (ch === '&' && words.tokens.length === 0 && !words.inWord && isBlank(source[i + 1] ?? '')) {
      i++;
      continue;
    }
    if ('(){};,|&<>'.includes(ch)) throw fail(i, `unquoted ${ch} is PowerShell syntax (quote the argument)`);
    if (ch === '#' && !words.inWord) {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (isBlank(ch)) {
      words.end();
      i++;
      continue;
    }
    words.add(ch, i);
    i++;
  }
  words.end();
  return words.tokens;
}
