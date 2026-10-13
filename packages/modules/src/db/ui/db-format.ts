import { type DbKind } from '@quiver/core';
import { Cylinder, Database, HardDrive, Zap } from 'lucide';
import type { IconNode } from '@quiver/ui';

export { csvEscape, formatCell, formatCellFull, rowsToCsv, rowsToJson, rowsToInsert, rowsToMarkdown } from '@quiver/core';

export const KIND_ICONS: Record<DbKind, IconNode> = { mysql: Database, postgres: Cylinder, sqlite: HardDrive, redis: Zap };
export const KIND_COLORS: Record<DbKind, string> = { mysql: 'text-sky-500', postgres: 'text-indigo-500', sqlite: 'text-emerald-500', redis: 'text-rose-500' };

export const REDIS_TYPE_COLORS: Record<string, string> = {
  string: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  hash: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  list: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  set: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  zset: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  stream: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-300',
};

export function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

export function formatTtl(ttl: number): string {
  if (ttl === -1) return 'no expiry';
  if (ttl === -2) return 'expired';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
  return `${Math.floor(ttl / 86400)}d ${Math.floor((ttl % 86400) / 3600)}h`;
}

/** Seconds as a short "3d 4h" / "12m" uptime. */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/** An ISO time as "just now", "5 min ago", "2 h ago", "3 d ago" or the date. */
export function formatAgo(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)} d ago`;
  return new Date(at).toLocaleDateString();
}

export function firstLine(text: string, max = 48): string {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('--')) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Quote a Redis argument for the console syntax (double quotes with escapes). */
export function redisQuote(arg: string): string {
  return /[\s"'\\]/.test(arg) || arg === '' ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg;
}
