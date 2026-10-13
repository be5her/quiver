import { prettyJson } from './json';
import type { DbExportFormat, SqlKind } from './models/db';
import { qualifiedName, quoteIdentifier, sqlLiteral } from './sql';

export interface ExportColumn {
  name: string;
}

/** Render any cell value as a single line of text. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object' && value !== null && '$bytes' in value) {
    const bytes = value as { $bytes: number; hex: string };
    return `0x${bytes.hex}${bytes.$bytes > 64 ? '…' : ''} (${bytes.$bytes} bytes)`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Multi-line, pretty version for detail views and copy buttons. Text holding a JSON object or array is pretty-printed too. */
export function formatCellFull(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return prettyJson(value) ?? value;
  if (typeof value === 'object' && value !== null && '$bytes' in value) return formatCell(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function csvEscape(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(columns: ExportColumn[], rows: unknown[][]): string {
  const head = columns.map((c) => csvEscape(c.name)).join(',');
  const body = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : csvEscape(formatCell(v)))).join(','));
  return [head, ...body].join('\n');
}

export function rowsToJson(columns: ExportColumn[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))),
    null,
    2,
  );
}

function markdownCell(value: unknown): string {
  return formatCell(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A GitHub-flavoured Markdown table; pipes and line breaks inside cells are escaped. */
export function rowsToMarkdown(columns: ExportColumn[], rows: unknown[][]): string {
  const head = `| ${columns.map((c) => markdownCell(c.name)).join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${columns.map((_, i) => markdownCell(r[i])).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

/** One INSERT per row, for moving data between databases or seeding fixtures. */
export function rowsToInsert(kind: SqlKind, table: string, database: string | null | undefined, columns: ExportColumn[], rows: unknown[][]): string {
  const target = qualifiedName(kind, table, database);
  const names = columns.map((c) => quoteIdentifier(kind, c.name)).join(', ');
  return rows.map((r) => `INSERT INTO ${target} (${names}) VALUES (${columns.map((_, i) => sqlLiteral(kind, r[i])).join(', ')});`).join('\n');
}

export interface ExportOptions {
  format: DbExportFormat;
  columns: ExportColumn[];
  rows: unknown[][];
  /** For `sql`: the dialect and the table the INSERTs target. */
  kind?: SqlKind;
  table?: string;
  database?: string | null;
}

export function formatRows({ format, columns, rows, kind, table, database }: ExportOptions): string {
  switch (format) {
    case 'csv':
      return rowsToCsv(columns, rows);
    case 'json':
      return rowsToJson(columns, rows);
    case 'markdown':
      return rowsToMarkdown(columns, rows);
    case 'sql':
      return rowsToInsert(kind ?? 'mysql', table ?? 'table', database, columns, rows);
  }
}

export const EXPORT_EXTENSIONS: Record<DbExportFormat, string> = { csv: 'csv', json: 'json', markdown: 'md', sql: 'sql' };
export const EXPORT_LABELS: Record<DbExportFormat, string> = { csv: 'CSV', json: 'JSON', markdown: 'Markdown', sql: 'INSERT statements' };
