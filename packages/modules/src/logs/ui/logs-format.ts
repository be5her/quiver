import { logLevelTone, prettyJson, type LogLevelTone, type LogsSession } from '@quiver/core';
import type { CodeLanguage } from '@quiver/ui';

const TONE_TEXT: Record<LogLevelTone, string> = {
  error: 'text-rose-600 dark:text-rose-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-sky-600 dark:text-sky-400',
  debug: 'text-muted',
  other: 'text-muted',
};

const TONE_DOT: Record<LogLevelTone, string> = {
  error: 'bg-rose-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
  debug: 'bg-slate-400',
  other: 'bg-slate-300 dark:bg-slate-600',
};

/** Text colour for a level, however the logger spells it. */
export function levelText(level: string | null): string {
  return TONE_TEXT[logLevelTone(level)];
}

/** The small dot or bar colour for a level. */
export function levelDot(level: string | null): string {
  return TONE_DOT[logLevelTone(level)];
}

/** The colour of a connection's sign-in dot. */
export function sessionDot(session: LogsSession): string {
  if (session.state === 'signed-in') return 'bg-success';
  if (session.state === 'signing-in') return 'bg-warning animate-pulse';
  if (session.state === 'signed-out') return 'bg-danger';
  return 'bg-muted/50';
}

export function sessionLabel(session: LogsSession): string {
  switch (session.state) {
    case 'signed-in':
      return session.user?.email || session.user?.login || 'Signed in';
    case 'signing-in':
      return 'Signing in…';
    case 'signed-out':
      return 'Not signed in';
    default:
      return 'Sign-in not checked';
  }
}

/** A direct connection's last check, which stands in for a sign-in: it needs none. */
export function directLabel(session: LogsSession): string {
  switch (session.state) {
    case 'signed-in':
      return 'Reachable';
    case 'signed-out':
      return session.error ?? 'Not reachable';
    default:
      return 'Not checked yet';
  }
}

/** The state line of any connection: who is signed in to Grafana, or how the direct server last answered. */
export function connectionStateLabel(conn: { kind?: string; session: LogsSession }): string {
  return conn.kind === 'victorialogs' ? directLabel(conn.session) : sessionLabel(conn.session);
}

/** `14:03:27.118`, in local time. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `Oct 13, 14:03:27.118`, for entries that span more than a day. */
export function dayTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clockTime(iso)}`;
}

/** A message for the detail pane: indented when it is JSON, with its numbers as written (a 64-bit id is not rounded), as it is otherwise. */
export function formatMessage(text: string): { text: string; language: CodeLanguage } {
  const json = prettyJson(text);
  return json === null ? { text, language: 'text' } : { text: json, language: 'json' };
}

/** One line for the list: whitespace runs folded, long messages cut. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 1000);
}
