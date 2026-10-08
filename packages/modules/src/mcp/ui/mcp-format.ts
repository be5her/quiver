import type { McpRecordingStatus, McpServerSummary, McpTransport } from '@quiver/core';
import type { CodeLanguage } from '@quiver/ui';

export const STATUS_LABEL: Record<McpServerSummary['status'], string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  connected: 'connected',
};

export const TRANSPORT_COLOR: Record<McpTransport, string> = {
  stdio: 'text-emerald-600 dark:text-emerald-400',
  http: 'text-sky-600 dark:text-sky-400',
  sse: 'text-violet-600 dark:text-violet-400',
};

/** The colour of a server's status dot. */
export function statusDot(status: McpServerSummary['status'], error: string | null): string {
  if (status === 'connected') return 'bg-success';
  if (status === 'connecting') return 'bg-warning animate-pulse';
  return error ? 'bg-danger' : 'bg-muted/50';
}

/** The colour of the recorder's dot: red while recording, amber while paused. */
export function recordingDot(state: McpRecordingStatus['state']): string {
  if (state === 'recording') return 'bg-danger animate-pulse';
  if (state === 'paused') return 'bg-warning';
  return 'bg-muted/50';
}

const AGENT_COLORS = ['text-sky-600 dark:text-sky-400', 'text-violet-600 dark:text-violet-400', 'text-amber-600 dark:text-amber-400', 'text-emerald-600 dark:text-emerald-400', 'text-rose-600 dark:text-rose-400'];

/** The same agent gets the same colour in every row, so two agents working at once are easy to tell apart. */
export function agentColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

export function languageForMime(mime: string | undefined, text: string): CodeLanguage {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('json')) return 'json';
  if (m.includes('html')) return 'html';
  if (m.includes('xml')) return 'xml';
  if (m.includes('javascript')) return 'javascript';
  if (m.includes('sql')) return 'sql';
  if (m.includes('graphql')) return 'graphql';
  if (!m || m.startsWith('text/')) return /^\s*[[{]/.test(text) && isJson(text) ? 'json' : 'text';
  return 'text';
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Text for a read-only block, pretty-printed when it is JSON. */
export function displayText(text: string, mime: string | undefined): { value: string; language: CodeLanguage } {
  const language = languageForMime(mime, text);
  if (language === 'json') {
    try {
      return { value: JSON.stringify(JSON.parse(text), null, 2), language };
    } catch {
      return { value: text, language: 'text' };
    }
  }
  return { value: text, language };
}

/** A whole number typed into a field, kept within bounds; anything else gives `fallback`. */
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
