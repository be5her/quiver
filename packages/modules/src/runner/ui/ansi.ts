// Colour codes in task output, turned into styled runs of text. Pure, so the unit test runs it without Angular.

/** The text attributes an SGR sequence (`ESC [ … m`) sets, carried from one line to the next as a terminal does. */
export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSpan {
  text: string;
  /** Inline CSS for the span, empty when it has no style. */
  css: string;
}

/**
 * The 16 basic colours through the theme's own tokens where there is one, so red stays readable on the light and the
 * dark canvas alike; black and white are the muted and foreground tokens, since either would vanish on one of them.
 */
const BASIC = [
  'var(--muted)',
  'var(--danger)',
  'var(--success)',
  'var(--warning)',
  '#3b82f6',
  '#c026d3',
  '#0891b2',
  'var(--fg)',
  'var(--muted)',
  'var(--danger)',
  'var(--success)',
  'var(--warning)',
  '#60a5fa',
  '#d946ef',
  '#06b6d4',
  'var(--fg)',
];

/** A colour of the 256-colour palette: the 16 basic ones, a 6×6×6 cube, then 24 greys. */
export function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return BASIC[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

/** Reads an extended colour (`38;5;n` or `38;2;r;g;b`) from `codes` at `i`, the 38 or 48; gives the colour and how many codes it took. */
function extended(codes: number[], i: number): { color?: string; used: number } {
  const mode = codes[i + 1];
  if (mode === 5) return { color: color256(codes[i + 2]), used: 3 };
  if (mode === 2) {
    const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
    const ok = [r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255);
    return { color: ok ? `rgb(${r},${g},${b})` : undefined, used: 5 };
  }
  return { used: 1 };
}

/** The style after one SGR sequence's codes. */
export function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((p) => (p === '' ? 0 : Number(p)));
  let s: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) s = {};
    else if (c === 1) s.bold = true;
    else if (c === 2) s.dim = true;
    else if (c === 3) s.italic = true;
    else if (c === 4) s.underline = true;
    else if (c === 7) s.inverse = true;
    else if (c === 22) s.bold = s.dim = undefined;
    else if (c === 23) s.italic = undefined;
    else if (c === 24) s.underline = undefined;
    else if (c === 27) s.inverse = undefined;
    else if (c >= 30 && c <= 37) s.fg = BASIC[c - 30];
    else if (c >= 90 && c <= 97) s.fg = BASIC[c - 90 + 8];
    else if (c === 39) s.fg = undefined;
    else if (c >= 40 && c <= 47) s.bg = BASIC[c - 40];
    else if (c >= 100 && c <= 107) s.bg = BASIC[c - 100 + 8];
    else if (c === 49) s.bg = undefined;
    else if (c === 38 || c === 48) {
      const { color, used } = extended(codes, i);
      if (color) s[c === 38 ? 'fg' : 'bg'] = color;
      i += used - 1;
    }
  }
  // Leave unset keys out, so two equal styles compare equal.
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as AnsiStyle;
}

export function styleCss(s: AnsiStyle): string {
  const fg = s.inverse ? (s.bg ?? 'var(--canvas)') : s.fg;
  const bg = s.inverse ? (s.fg ?? 'var(--fg)') : s.bg;
  const parts: string[] = [];
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background-color:${bg}`);
  if (s.bold) parts.push('font-weight:600');
  if (s.dim) parts.push('opacity:.65');
  if (s.italic) parts.push('font-style:italic');
  if (s.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

/**
 * Escape sequences: SGR (kept as style), any other CSI (cursor moves, erase line), OSC (titles, hyperlinks, ended by
 * BEL or ST) and two-character escapes, all dropped. Linear: every alternative is a run of one character class.
 */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** One line of output as styled spans, starting from `style` (the previous line's end); also gives the style it ends with. */
export function parseAnsi(text: string, style: AnsiStyle = {}): { spans: AnsiSpan[]; style: AnsiStyle } {
  const spans: AnsiSpan[] = [];
  let current = style;
  let last = 0;
  const push = (chunk: string) => {
    if (!chunk) return;
    const css = styleCss(current);
    const prev = spans.at(-1);
    if (prev && prev.css === css) prev.text += chunk;
    else spans.push({ text: chunk, css });
  };
  for (const m of text.matchAll(ESCAPES)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) current = applySgr(current, m[1]);
  }
  push(text.slice(last));
  return { spans, style: current };
}

/** The text without escape sequences, for searching. */
export function plainText(text: string): string {
  return text.replace(ESCAPES, '');
}
