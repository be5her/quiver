import { DB_KIND_LABELS, toErrorPayload, type DbAccess, type DbKind, type ErrorPayload, type TeleportLoginResult } from '@quiver/core';
import { Button, cn, invoke, notify } from '@quiver/ui';
import { Cable, Database, HardDrive, LogIn, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

export const KIND_ICONS: Record<DbKind, LucideIcon> = { mysql: Database, sqlite: HardDrive, redis: Zap };
export const KIND_COLORS: Record<DbKind, string> = { mysql: 'text-sky-500', sqlite: 'text-emerald-500', redis: 'text-rose-500' };

export function KindIcon({ kind, className }: { kind: DbKind; className?: string }) {
  const Icon = KIND_ICONS[kind];
  return <Icon className={cn('size-3.5 shrink-0', KIND_COLORS[kind], className)} aria-label={DB_KIND_LABELS[kind]} />;
}

/** Small marker for connections that go through a tunnel. */
export function AccessBadge({ access, className }: { access: DbAccess; className?: string }) {
  if (access.type === 'direct') return null;
  const Icon = access.type === 'teleport' ? ShieldCheck : Cable;
  const title = access.type === 'teleport' ? `Teleport tunnel: ${access.database} as ${access.dbUser}` : `Tunnel command: ${access.command}`;
  return <Icon className={cn('size-3 shrink-0 text-muted', className)} aria-label={title} />;
}

/** Run `tsh login` from anywhere in the app and report the outcome. Returns true when a session is now valid. */
export async function teleportLoginAgain(): Promise<boolean> {
  try {
    const result = await invoke<TeleportLoginResult>('teleport.login', {}, null);
    if (result.ok) notify(`Logged in to Teleport as ${result.status.user ?? 'user'}`, 'success');
    else notify(result.output.at(-1) ?? 'Teleport login did not complete', 'error');
    return result.ok;
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
    return false;
  }
}

/**
 * Error box for query, table and key views. When the cause is a missing or expired Teleport
 * certificate it offers "Log in again" and retries the caller's action afterwards.
 */
export function DbError({ error, onRetry, compact }: { error: ErrorPayload; onRetry?(): void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const loginRequired = error.code === 'TELEPORT_LOGIN_REQUIRED';
  const relogin = async () => {
    setBusy(true);
    try {
      if (await teleportLoginAgain()) onRetry?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn('flex flex-col gap-2 items-start', compact ? 'px-2 py-1' : 'p-3')} role="alert">
      <pre className={cn('text-danger whitespace-pre-wrap break-words font-mono', compact ? 'text-[11px]' : 'text-xs')}>{error.message}</pre>
      <div className="flex items-center gap-2">
        {loginRequired && (
          <Button size="sm" variant="primary" icon={<LogIn className="size-3.5" />} loading={busy} onClick={() => void relogin()}>
            Log in again
          </Button>
        )}
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

export const REDIS_TYPE_COLORS: Record<string, string> = {
  string: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  hash: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  list: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  set: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  zset: 'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  stream: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-300',
};

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

/** Multi-line, pretty version for the detail strip and copy buttons. */
export function formatCellFull(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return value;
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

export function rowsToCsv(columns: { name: string }[], rows: unknown[][]): string {
  const head = columns.map((c) => csvEscape(c.name)).join(',');
  const body = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : csvEscape(formatCell(v)))).join(','));
  return [head, ...body].join('\n');
}

export function rowsToJson(columns: { name: string }[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i] ?? null]))),
    null,
    2,
  );
}

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

export function firstLine(text: string, max = 48): string {
  const line = text.trim().split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('--')) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Quote a Redis argument for the console syntax (double quotes with escapes). */
export function redisQuote(arg: string): string {
  return /[\s"'\\]/.test(arg) || arg === '' ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg;
}
