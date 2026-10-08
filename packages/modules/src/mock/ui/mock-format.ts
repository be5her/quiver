import type { MockCapturedRequest } from '@quiver/core';
import { formatBytes, type CodeLanguage } from '@quiver/ui';

export const OUTCOME_LABEL: Record<MockCapturedRequest['outcome'], string> = {
  route: 'route',
  fallback: 'fallback',
  forwarded: 'forwarded',
  preflight: 'preflight',
  error: 'error',
};

export const OUTCOME_CLASS: Record<MockCapturedRequest['outcome'], string> = {
  route: 'text-success',
  fallback: 'text-muted',
  forwarded: 'text-sky-600 dark:text-sky-400',
  preflight: 'text-muted',
  error: 'text-danger',
};

export const TEMPLATE_HINT = 'Templates: {{params.id}} {{query.page}} {{headers.authorization}} {{body.user.email}} {{$uuid}} {{$isoTimestamp}} {{$randomInt}}';

export interface FormattedBody {
  text: string;
  language: CodeLanguage;
  note: string | null;
}

export function headerOf(headers: [string, string][], name: string): string | null {
  return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
}

/** A captured or replayed body for display: pretty JSON, base64 for binary, with a note when it was cut. */
export function formatBody(body: string, encoding: 'utf8' | 'base64', contentType: string | null, truncated: boolean, size: number): FormattedBody {
  const note = truncated ? `Only the first ${formatBytes(body.length)} of ${formatBytes(size)} were kept.` : null;
  if (!body) return { text: '', language: 'text', note };
  if (encoding === 'base64') return { text: `${body.slice(0, 4000)}${body.length > 4000 ? '…' : ''}`, language: 'text', note: `Binary body (${formatBytes(size)}), shown as base64.${note ? ` ${note}` : ''}` };
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(body);
  if (looksJson) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), language: 'json', note };
    } catch {
      return { text: body, language: 'json', note };
    }
  }
  if (/html/i.test(contentType ?? '')) return { text: body, language: 'html', note };
  if (/xml/i.test(contentType ?? '')) return { text: body, language: 'xml', note };
  return { text: body, language: 'text', note };
}

/** A whole number typed into a field, kept within bounds; anything else gives `fallback`. */
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The language a response body is edited in, guessed from how it starts. */
export function bodyLanguage(body: string): CodeLanguage {
  return /^\s*[[{]/.test(body) ? 'json' : /^\s*</.test(body) ? 'html' : 'text';
}
