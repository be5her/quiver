import { Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { cookieExpiry, jsonPath, parseSetCookie, responseFileName, toErrorPayload, type ApiResponse, type SetCookie } from '@quiver/core';
import { Button, CodeEditor, EmptyState, HostBridge, Input, Segment, Segmented, Spinner, Toasts, formatBytes, formatMs, statusColor, type CodeLanguage } from '@quiver/ui';
import { ChevronRight, Copy, Download, Search } from 'lucide';
import { ApiActions } from './api-actions';
import { HeaderTable } from './header-table';

type View = 'body' | 'headers' | 'cookies' | 'request';

interface Shown {
  text: string;
  language: CodeLanguage;
}

function languageOf(response: ApiResponse): CodeLanguage {
  const ct = response.contentType ?? '';
  if (/json/i.test(ct) || /^\s*[[{]/.test(response.body)) return 'json';
  if (/html/i.test(ct)) return 'html';
  if (/xml/i.test(ct)) return 'xml';
  return 'text';
}

function formatBody(response: ApiResponse, pretty: boolean): Shown {
  if (response.bodyEncoding === 'base64') {
    return {
      text: `Binary response (${formatBytes(response.size)}). Save it to keep the file. Base64:\n${response.body.slice(0, 2000)}${response.body.length > 2000 ? '…' : ''}`,
      language: 'text',
    };
  }
  const language = languageOf(response);
  if (language === 'json' && pretty) {
    try {
      return { text: JSON.stringify(JSON.parse(response.body), null, 2), language };
    } catch {
      // not JSON after all: show it as it came
    }
  }
  return { text: response.body, language };
}

/** A data URL an `<img>` can show, for image responses that arrived whole. */
function imageSource(response: ApiResponse): string | null {
  const type = (response.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/') || response.truncated || !response.body) return null;
  if (response.bodyEncoding === 'base64') return `data:${type};base64,${response.body}`;
  return type === 'image/svg+xml' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(response.body)}` : null;
}

interface CookieRow extends SetCookie {
  expiry: string;
  flags: string;
  /** What the cookie jar did with it: kept, deleted (an expiry in the past), refused, or not used. */
  jar: string;
  jarReason: string;
}

/**
 * The last response: status, timing (with a bar for redirects, waiting and download), size and the
 * redirects followed, then the body (pretty or raw, searchable, filtered by a JSON path, images
 * previewed, saved to a file), the headers of the final response and of each redirect, the cookies
 * it set, or what was sent.
 */
@Component({
  selector: 'q-response-pane',
  imports: [Button, CodeEditor, EmptyState, HeaderTable, Input, Segment, Segmented, Spinner],
  templateUrl: './response-pane.html',
  host: { class: 'contents' },
})
export class ResponsePane {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  private readonly api = inject(ApiActions);
  private readonly editor = viewChild<CodeEditor>('bodyEditor');

  readonly response = input<ApiResponse | null>(null);
  readonly error = input<string | null>(null);
  readonly sending = input(false);

  protected readonly icons = { ChevronRight, Copy, Download, Search };
  protected readonly statusColor = statusColor;
  protected readonly formatMs = formatMs;
  protected readonly formatBytes = formatBytes;
  protected readonly view = signal<View>('body');
  protected readonly pretty = signal(true);
  protected readonly preview = signal(true);
  /** A JSON path over the body; kept across sends so a re-send shows the same slice. */
  protected readonly filter = signal('');
  protected readonly filterPlaceholder = '$.items[*].id';

  private readonly body = computed<Shown>(() => {
    const response = this.response();
    return response ? formatBody(response, this.pretty()) : { text: '', language: 'text' };
  });
  protected readonly isJson = computed(() => this.body().language === 'json' && this.response()?.bodyEncoding === 'utf8');
  private readonly parsed = computed<{ ok: true; value: unknown } | { ok: false }>(() => {
    const response = this.response();
    if (!response || !this.isJson()) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(response.body) };
    } catch {
      return { ok: false };
    }
  });
  /** What the filter selects: one value as it is, several as an array; or why the path cannot be read. */
  private readonly filtered = computed<{ text: string; error: null } | { text: null; error: string } | null>(() => {
    const path = this.filter().trim();
    const parsed = this.parsed();
    if (!path || !parsed.ok) return null;
    try {
      const values = jsonPath(parsed.value, path);
      return { text: JSON.stringify(values.length === 1 ? values[0] : values, null, 2) ?? 'undefined', error: null };
    } catch (err) {
      return { text: null, error: (err as Error).message };
    }
  });
  protected readonly filterError = computed(() => this.filtered()?.error ?? null);
  protected readonly matchCount = computed(() => {
    const path = this.filter().trim();
    const parsed = this.parsed();
    if (!path || !parsed.ok || this.filterError()) return null;
    try {
      return jsonPath(parsed.value, path).length;
    } catch {
      return null;
    }
  });
  /** The text in the editor: the filtered slice when a filter applies, else the body. */
  protected readonly shown = computed<Shown>(() => {
    const filtered = this.filtered();
    return filtered?.text != null ? { text: filtered.text, language: 'json' } : this.body();
  });
  protected readonly image = computed(() => {
    const response = this.response();
    return response ? imageSource(response) : null;
  });
  protected readonly showImage = computed(() => Boolean(this.image()) && this.preview());

  protected readonly cookies = computed<CookieRow[]>(() => {
    const now = Date.now();
    return (this.response()?.setCookies ?? []).flatMap((header) => {
      const cookie = parseSetCookie(header);
      if (!cookie) return [];
      const at = cookieExpiry(cookie, now);
      const flags = [cookie.secure ? 'Secure' : '', cookie.httpOnly ? 'HttpOnly' : '', cookie.sameSite ? `SameSite=${cookie.sameSite}` : ''].filter(Boolean).join(' · ');
      const report = this.response()?.cookieJar;
      const refused = report?.rejected.find((r) => r.name === cookie.name);
      const jar = !report ? 'not used' : refused ? 'refused' : report.deleted.includes(cookie.name) ? 'deleted' : report.stored.includes(cookie.name) ? 'kept' : '';
      return [{ ...cookie, flags, jar, jarReason: refused?.reason ?? (report ? '' : 'The cookie jar is off for this request'), expiry: at === null ? 'Session' : at <= now ? 'Expired (deletes it)' : new Date(at).toLocaleString() }];
    });
  });

  /** Where the time went: following redirects, waiting for the final response, reading its body. */
  protected readonly timing = computed(() => {
    const response = this.response();
    if (!response) return null;
    const { total, ttfb, download } = response.timings;
    const redirects = response.redirects.reduce((sum, hop) => sum + hop.durationMs, 0);
    const waiting = Math.max(0, ttfb - redirects);
    const pct = (ms: number) => (total > 0 ? `${(ms / total) * 100}%` : '0%');
    const parts = [response.redirects.length ? `Redirects ${formatMs(redirects)}` : '', `Waiting ${formatMs(waiting)}`, `Download ${formatMs(download)}`].filter(Boolean);
    return { redirects: pct(redirects), waiting: pct(waiting), download: pct(download), title: `${parts.join(' · ')}\nTotal ${formatMs(total)}` };
  });

  protected togglePretty(): void {
    this.pretty.update((pretty) => !pretty);
  }

  protected togglePreview(): void {
    this.preview.update((preview) => !preview);
  }

  protected setFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected copyBody(): void {
    this.toasts.copy(this.shown().text);
  }

  protected search(): void {
    this.preview.set(false);
    this.editor()?.openSearch();
  }

  /** Saves the body as it arrived (not prettified or filtered) to a file picked in the save dialog. */
  protected async save(): Promise<void> {
    const response = this.response();
    if (!response) return;
    try {
      const picked = await this.host.invoke<{ path: string | null }>('app.pickSavePath', { title: 'Save response body', defaultPath: responseFileName(response.url, response.contentType) });
      if (!picked.path) return;
      const saved = await this.host.invoke<{ path: string; bytes: number }>('api.response.save', { path: picked.path, body: response.body, bodyEncoding: response.bodyEncoding });
      const name = saved.path.split(/[\\/]/).pop();
      this.toasts.notify(`Saved ${formatBytes(saved.bytes)} to ${name}${response.truncated ? ' (the body was truncated)' : ''}`, response.truncated ? 'info' : 'success');
    } catch (err) {
      this.toasts.error(toErrorPayload(err).message);
    }
  }

  /** A captured value short enough for the strip; the full one is in the environment. */
  protected shorten(value: string | null): string {
    if (value === null) return '';
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }

  protected openJar(): void {
    this.api.openCookieJar();
  }

  protected showHeaders(): void {
    this.view.set('headers');
  }
}
