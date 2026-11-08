import type { DbQueryResult, LogsSession, MetabaseConnectionSummary, MetabaseParameter, MetabaseSession, MetabaseTable } from '@quiver/core';
import type { SQLNamespace } from '@quiver/ui';
import { sessionDot, sessionLabel } from '../../logs/ui/logs-format';

/** Metabase's session in the Logs shape, whose dot and label helpers it shares (the user's email stands in for the login). */
function asLogsSession(s: MetabaseSession): LogsSession {
  return { ...s, user: s.user ? { login: s.user.email, email: s.user.email, name: s.user.name } : null };
}

/** The colour of a connection's sign-in dot. */
export function mbSessionDot(session: MetabaseSession): string {
  return sessionDot(asLogsSession(session));
}

/** The connection's sign-in line: who it reaches the server as, or why it cannot. */
export function connectionSessionText(conn: MetabaseConnectionSummary): string {
  const s = conn.session;
  if (!conn.url) return 'Enter the Metabase address first';
  if (conn.auth === 'apikey' && !conn.hasApiKey) return 'No API key on this machine';
  if (s.state === 'signed-in') return `Signed in as ${s.user?.name || s.user?.email || 'you'}`;
  if (conn.auth === 'apikey' && s.state === 'unknown') return 'Key not checked';
  return sessionLabel(asLogsSession(s));
}

/** `orders`, or `"Order Lines"` when it needs quoting; MySQL quotes with backticks. */
function quoteIdent(name: string, engine: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  const q = engine === 'mysql' || engine === 'mariadb' ? '`' : '"';
  return `${q}${name.split(q).join(q + q)}${q}`;
}

/** The query a table opens with: its first hundred rows. */
export function selectFromTable(table: Pick<MetabaseTable, 'name' | 'schema'>, engine: string): string {
  const name = table.schema ? `${quoteIdent(table.schema, engine)}.${quoteIdent(table.name, engine)}` : quoteIdent(table.name, engine);
  return `SELECT * FROM ${name} LIMIT 100`;
}

/** Completion for the editor: every table (by name, and by `schema.name` when it has one) with its fields. */
export function tablesSchema(tables: MetabaseTable[] | undefined): SQLNamespace | undefined {
  if (!tables) return undefined;
  const entries: [string, { label: string; type: string; detail: string }[]][] = [];
  for (const t of tables) {
    const fields = t.fields.map((f) => ({ label: f.name, type: 'property', detail: f.databaseType ?? f.baseType.replace(/^type\//, '') }));
    entries.push([t.name, fields]);
    if (t.schema) entries.push([`${t.schema}.${t.name}`, fields]);
  }
  return Object.fromEntries(entries);
}

/** `3 rows · 12 ms`. */
export function resultSummary(result: DbQueryResult): string {
  const n = result.rowCount;
  return `${n.toLocaleString()} row${n === 1 ? '' : 's'} · ${result.durationMs < 1000 ? `${Math.round(result.durationMs)} ms` : `${(result.durationMs / 1000).toFixed(2)} s`}`;
}

export type ParameterInputType = 'number' | 'date' | 'text';

/** How a question's parameter is typed in: numbers and dates get their own inputs, the rest is text. */
export function parameterInputType(param: Pick<MetabaseParameter, 'type'>): ParameterInputType {
  if (param.type.startsWith('number')) return 'number';
  if (param.type.startsWith('date/single') || param.type === 'date') return 'date';
  return 'text';
}

/** The text a parameter starts with: its default, when it has one Quiver can show. */
export function parameterDefault(param: MetabaseParameter): string {
  const value = Array.isArray(param.default) ? param.default[0] : param.default;
  return value === null || value === undefined ? '' : String(value);
}

/** The value sent to Metabase for what was typed: a number for number parameters, the text otherwise. */
export function parameterValue(param: MetabaseParameter, text: string): unknown {
  if (parameterInputType(param) === 'number') {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return text;
}
