import { Component, computed, inject, input, linkedSignal, output } from '@angular/core';
import {
  HttpMethodSchema,
  capturedToCurl,
  keyValue,
  mockServerUrl,
  replayableHeaders,
  toErrorPayload,
  type ApiRequest,
  type MockCapturedRequest,
  type MockReplayResult,
  type MockServerSummary,
} from '@quiver/core';
import { AppState, Badge, Button, Dialogs, HostBridge, METHOD_COLORS, Segment, Segmented, Toasts, formatBytes, formatMs, statusColor } from '@quiver/ui';
import { Copy, ExternalLink, Plus, Repeat } from 'lucide';
import { ApiActions, HeaderTable } from '../../api/ui';
import { MockBodyPane } from './body-pane';
import { MockActions } from './mock-actions';
import { OUTCOME_CLASS, OUTCOME_LABEL, formatBody, headerOf } from './mock-format';
import { MockResponseBlock } from './response-block';

type DetailView = 'body' | 'headers' | 'query' | 'response';

/** One captured request: what came in, what was answered, and ways to reuse it. */
@Component({
  selector: 'q-mock-request-detail',
  imports: [Badge, Button, HeaderTable, MockBodyPane, MockResponseBlock, Segment, Segmented],
  templateUrl: './request-detail.html',
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'mock-request-detail' },
})
export class MockRequestDetail {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);
  private readonly api = inject(ApiActions);
  private readonly mock = inject(MockActions);

  readonly req = input.required<MockCapturedRequest>();
  readonly server = input.required<MockServerSummary>();
  readonly createRoute = output<MockCapturedRequest>();

  protected readonly icons = { Copy, ExternalLink, Plus, Repeat };
  protected readonly methodColors = METHOD_COLORS;
  protected readonly outcomeClass = OUTCOME_CLASS;
  protected readonly outcomeLabel = OUTCOME_LABEL;
  protected readonly statusColor = statusColor;
  protected readonly formatMs = formatMs;
  protected readonly formatBytes = formatBytes;

  private readonly reqId = computed(() => this.req().id);
  /** Picking another request starts over: its body, no replay. */
  protected readonly view = linkedSignal<string, DetailView>({ source: this.reqId, computation: () => 'body' });
  protected readonly replay = linkedSignal<string, MockReplayResult | null>({ source: this.reqId, computation: () => null });
  protected readonly replayError = linkedSignal<string, string | null>({ source: this.reqId, computation: () => null });
  protected readonly replaying = linkedSignal<string, boolean>({ source: this.reqId, computation: () => false });

  private readonly baseUrl = computed(() => this.server().url ?? mockServerUrl(this.server()));
  protected readonly at = computed(() => new Date(this.req().at).toLocaleString());
  protected readonly query = computed(() => Object.entries(this.req().query));
  protected readonly body = computed(() => {
    const req = this.req();
    return formatBody(req.body, req.bodyEncoding, req.contentType, req.truncated, req.size);
  });
  protected readonly responseBody = computed(() => {
    const res = this.req().response;
    return formatBody(res.body, res.bodyEncoding, headerOf(res.headers, 'content-type'), res.truncated, res.size);
  });
  protected readonly replayAnswer = computed(() => {
    const replay = this.replay();
    if (!replay) return null;
    return {
      title: `Replay to ${replay.url}: ${replay.status} ${replay.statusText}`,
      headers: replay.headers,
      body: formatBody(replay.body, replay.bodyEncoding, headerOf(replay.headers, 'content-type'), replay.truncated, replay.size),
    };
  });

  protected async doReplay(): Promise<void> {
    const target = await this.dialogs.prompt({ title: 'Replay request', label: 'Send it to (base URL keeps the captured path)', defaultValue: this.mock.lastReplayTarget, confirmLabel: 'Send' });
    if (!target?.trim()) return;
    this.mock.lastReplayTarget = target.trim();
    const reqId = this.reqId();
    this.replaying.set(true);
    this.replayError.set(null);
    try {
      const result = await this.host.invoke<MockReplayResult>('mock.request.replay', { serverId: this.server().id, requestId: reqId, url: target.trim() });
      if (this.reqId() === reqId) this.replay.set(result);
    } catch (err) {
      if (this.reqId() !== reqId) return;
      this.replay.set(null);
      this.replayError.set(toErrorPayload(err).message);
    } finally {
      if (this.reqId() === reqId) this.replaying.set(false);
    }
  }

  protected copyCurl(): void {
    this.toasts.copy(capturedToCurl(this.req(), this.baseUrl()), 'Copied curl command');
  }

  protected async openInApi(): Promise<void> {
    const req = this.req();
    try {
      const method = (HttpMethodSchema.options as string[]).includes(req.method) ? req.method : 'GET';
      const created = await this.host.invoke<ApiRequest>('api.request.create', { name: `${req.method} ${req.path}`, method, url: `${this.baseUrl()}${req.url}` });
      const headers = replayableHeaders(req.headers).map(([k, v]) => keyValue(k, v));
      const body: ApiRequest['body'] =
        req.bodyEncoding === 'utf8' && req.body ? (/json/i.test(req.contentType ?? '') ? { type: 'json', content: req.body } : { type: 'text', content: req.body }) : { type: 'none' };
      const saved = await this.host.invoke<ApiRequest>('api.request.save', { request: { ...created, headers, body } });
      this.app.setActiveModule('api');
      this.api.openRequestTab(saved);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
