import type { RealtimeConnectionSummary, RealtimeMessage } from '@quiver/core';
import { formatBytes, type CodeLanguage } from '@quiver/ui';

export const STATUS_LABEL: Record<RealtimeConnectionSummary['status'], string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  open: 'connected',
  reconnecting: 'reconnecting…',
};

export const KIND_LABEL: Record<RealtimeMessage['kind'], string> = { text: 'text', binary: 'binary', event: 'event', open: 'open', close: 'close', error: 'error', info: 'info' };

/** The colour of a connection's status dot. */
export function statusDot(status: RealtimeConnectionSummary['status'], error: string | null): string {
  if (status === 'open') return 'bg-success';
  if (status === 'connecting' || status === 'reconnecting') return 'bg-warning animate-pulse';
  return error ? 'bg-danger' : 'bg-muted/50';
}

/** The WS or SSE label, in its colour. */
export function kindClass(kind: RealtimeConnectionSummary['kind']): string {
  return kind === 'sse' ? 'text-violet-600 dark:text-violet-400' : 'text-sky-600 dark:text-sky-400';
}

/** A message for the detail pane: pretty JSON, or base64 for a binary frame. */
export function formatData(message: RealtimeMessage): { text: string; language: CodeLanguage } {
  if (message.encoding === 'base64') return { text: `Binary frame (${formatBytes(message.size)}), base64:\n${message.data.slice(0, 4000)}${message.data.length > 4000 ? '…' : ''}`, language: 'text' };
  if (/^\s*[[{]/.test(message.data)) {
    try {
      return { text: JSON.stringify(JSON.parse(message.data), null, 2), language: 'json' };
    } catch {
      return { text: message.data, language: 'text' };
    }
  }
  return { text: message.data, language: 'text' };
}

/** JSON when the text looks like an object or array, plain text otherwise. */
export function textLanguage(text: string): CodeLanguage {
  return /^\s*[[{]/.test(text) ? 'json' : 'text';
}

/** A whole number typed into a field, kept within bounds; anything else gives `fallback`. */
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
