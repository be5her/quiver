import { Component, computed, effect, inject, input, linkedSignal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { MockMethodSchema, MockServerSchema, mockServerUrl, newMockRoute, newMockServer, type MockCapturedRequest, type MockMethod, type MockServer, type MockServerSummary } from '@quiver/core';
import { Button, HostBridge, Icon, IconButton, Input, Segment, Segmented, Spinner, TabsState, Toasts, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Copy, Play, Save, Square } from 'lucide';
import { MockActions, type ServerView } from './mock-actions';
import { MockRequestsView } from './requests-view';
import { MockRoutesView } from './routes-view';
import { MockSettingsView } from './settings-view';

function definitionOf(summary: MockServerSummary): MockServer {
  return MockServerSchema.parse(summary);
}

/** A mock server: its routes, the requests it captured, and its settings. Ctrl+S saves and applies. */
@Component({
  selector: 'q-mock-server-tab',
  imports: [Button, FormField, Icon, IconButton, Input, MockRequestsView, MockRoutesView, MockSettingsView, Segment, Segmented, Spinner],
  templateUrl: './server-tab.html',
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class MockServerTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly mock = inject(MockActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, Play, Save, Square };
  private readonly serverId = computed(() => String(this.tab().data?.['id'] ?? ''));
  protected readonly summary = invokeResource<MockServerSummary>('mock.server.get', () => ({ id: this.serverId() }), { refreshOn: ['mock-servers'] });
  private readonly saved = computed(() => {
    const summary = this.summary.value();
    return summary ? definitionOf(summary) : undefined;
  });
  /** What the fields edit. Changes made elsewhere (MCP, another tab) replace it while it has no unsaved edits. */
  protected readonly draft = linkedSignal<MockServer | undefined, MockServer>({
    source: this.saved,
    computation: (saved, previous) => {
      if (!previous?.source) return saved ?? previous?.value ?? newMockServer();
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !saved ? previous.value : saved;
    },
  });
  protected readonly serverForm = form(this.draft);
  protected readonly loaded = computed(() => Boolean(this.summary.value()));
  protected readonly loadError = computed(() => this.summary.error()?.message ?? null);
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    return Boolean(saved && JSON.stringify(this.draft()) !== JSON.stringify(saved));
  });
  /** The section on screen; the sidebar can ask for another one (and a route) through the tab's data. */
  protected readonly view = linkedSignal<unknown, ServerView>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => untracked(() => (this.tab().data?.['view'] as ServerView | undefined)) ?? previous?.value ?? 'routes',
  });
  protected readonly routeId = linkedSignal<unknown, string | null>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => untracked(() => (this.tab().data?.['routeId'] as string | undefined)) ?? previous?.value ?? null,
  });
  protected readonly url = computed(() => {
    const summary = this.summary.value();
    return summary ? (summary.url ?? mockServerUrl(summary)) : '';
  });
  protected readonly dot = computed(() => {
    const summary = this.summary.value();
    return summary?.running ? 'bg-success' : summary?.error ? 'bg-danger' : 'bg-muted/50';
  });

  constructor() {
    injectHostEvent('mock.changed', (p) => p.serverId === this.serverId() && this.summary.reload());

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  protected patch(patch: Partial<MockServer>): void {
    this.draft.update((draft) => ({ ...draft, ...patch }));
  }

  protected copyUrl(): void {
    this.toasts.copy(this.url());
  }

  protected async save(): Promise<void> {
    try {
      const stored = await this.host.invoke<MockServerSummary>('mock.server.save', { server: this.draft() });
      this.draft.set(definitionOf(stored));
      this.summary.reload();
      this.tabs.updateTab(this.scope(), this.tab().id, { title: stored.name });
      this.toasts.notify(stored.running ? 'Saved and applied to the running server' : 'Saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** Turn a captured request into a route that answers its method and path, the way it was answered. */
  protected addRouteFromRequest(req: MockCapturedRequest): void {
    const method = (MockMethodSchema.options as string[]).includes(req.method) ? (req.method as MockMethod) : 'ANY';
    const forwarded = req.outcome === 'forwarded' && req.response.bodyEncoding === 'utf8';
    const contentType = req.response.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const route = newMockRoute({
      method,
      path: req.path,
      status: forwarded ? req.response.status : 200,
      headers: forwarded && contentType ? [{ id: `h-${Date.now()}`, key: 'Content-Type', value: contentType, enabled: true }] : [],
      body: forwarded ? req.response.body : '{\n  "ok": true\n}',
      description: `From request at ${new Date(req.at).toLocaleString()}`,
    });
    this.draft.update((draft) => ({ ...draft, routes: [...draft.routes, route] }));
    this.routeId.set(route.id);
    this.view.set('routes');
    this.toasts.notify('Route added. Save to apply it.', 'info');
  }
}
