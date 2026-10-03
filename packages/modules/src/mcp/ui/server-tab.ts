import { Component, computed, effect, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { McpServerSchema, joinCommandLine, newMcpServer, splitCommandLine, transportLabel, type McpServer, type McpServerSummary } from '@quiver/core';
import { Button, HostBridge, Input, Segment, Segmented, Spinner, TabsState, Toasts, VariableInput, formatMs, injectHostEvent, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { Activity, Plug, Save, Unplug } from 'lucide';
import { ApiVariables } from '../../api/ui';
import { McpInfoView } from './info-view';
import { McpLogView } from './log-view';
import { McpActions, type ServerView } from './mcp-actions';
import { STATUS_LABEL, TRANSPORT_COLOR, statusDot } from './mcp-format';
import { McpPromptsView } from './prompts-view';
import { McpResourcesView } from './resources-view';
import { McpSettingsView } from './settings-view';
import { McpToolsView } from './tools-view';

function definitionOf(summary: McpServerSummary): McpServer {
  return McpServerSchema.parse(summary);
}

/** An MCP server: its tools, resources and prompts, the traffic log, what it announced, and how to reach it. Ctrl+S saves. */
@Component({
  selector: 'q-mcp-server-tab',
  imports: [Button, FormField, Input, McpInfoView, McpLogView, McpPromptsView, McpResourcesView, McpSettingsView, McpToolsView, Segment, Segmented, Spinner, VariableInput],
  templateUrl: './server-tab.html',
  hostDirectives: [ApiVariables],
  host: { class: 'contents', '(keydown)': 'shortcut($event)' },
})
export class McpServerTab implements TabComponent {
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);
  protected readonly mcp = inject(McpActions);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Activity, Plug, Save, Unplug };
  protected readonly statusLabel = STATUS_LABEL;
  protected readonly transportColor = TRANSPORT_COLOR;
  protected readonly commandPlaceholder = 'npx -y @modelcontextprotocol/server-filesystem {{projectDir}}';
  private readonly serverId = computed(() => String(this.tab().data?.['id'] ?? ''));
  protected readonly summary = invokeResource<McpServerSummary>('mcp.server.get', () => ({ id: this.serverId() }), { refreshOn: ['mcp-servers'] });
  private readonly saved = computed(() => {
    const summary = this.summary.value();
    return summary ? definitionOf(summary) : undefined;
  });
  /** What the fields edit. Changes made elsewhere (MCP, another tab) replace it while it has no unsaved edits. */
  protected readonly draft = linkedSignal<McpServer | undefined, McpServer>({
    source: this.saved,
    computation: (saved, previous) => {
      if (!previous?.source) return saved ?? previous?.value ?? newMcpServer();
      const edited = JSON.stringify(previous.value) !== JSON.stringify(previous.source);
      return edited || !saved ? previous.value : saved;
    },
  });
  protected readonly serverForm = form(this.draft);
  /** The stdio command as typed; split into command and arguments on every change, joined again only when the definition is reloaded. */
  protected readonly commandLine = linkedSignal<McpServer | undefined, string>({
    source: this.saved,
    computation: (saved, previous) => {
      const draft = untracked(this.draft);
      if (previous && saved && JSON.stringify(draft) !== JSON.stringify(saved)) return previous.value;
      return saved ? joinCommandLine(saved.command, saved.args) : '';
    },
  });
  protected readonly loadError = computed(() => this.summary.error()?.message ?? null);
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    return Boolean(saved && JSON.stringify(this.draft()) !== JSON.stringify(saved));
  });
  /** The section on screen; the sidebar can ask for another one through the tab's data. */
  protected readonly view = linkedSignal<unknown, ServerView>({
    source: () => this.tab().data?.['nonce'],
    computation: (_nonce, previous) => untracked(() => (this.tab().data?.['view'] as ServerView | undefined)) ?? previous?.value ?? 'tools',
  });
  protected readonly busy = signal(false);
  protected readonly isStdio = computed(() => this.draft().transport === 'stdio');
  protected readonly open = computed(() => this.summary.value()?.status !== 'disconnected');
  protected readonly transport = computed(() => transportLabel(this.draft().transport));
  protected readonly urlPlaceholder = computed(() => (this.draft().transport === 'sse' ? 'https://{{host}}/sse' : 'https://{{host}}/mcp'));
  protected readonly dot = computed(() => {
    const summary = this.summary.value();
    return summary ? statusDot(summary.status, summary.error) : '';
  });

  constructor() {
    injectHostEvent('mcp.changed', (p) => p.serverId === this.serverId() && p.reason !== 'log' && this.summary.reload());

    effect(() => {
      const dirty = this.dirty();
      const tab = this.tab();
      if (tab.dirty !== dirty) untracked(() => this.tabs.updateTab(this.scope(), tab.id, { dirty }));
    });
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.saveAndSay();
    }
  }

  protected connectKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !this.open()) void this.toggle();
  }

  protected setCommand(text: string): void {
    this.commandLine.set(text);
    const [command = '', ...args] = splitCommandLine(text);
    this.draft.update((draft) => ({ ...draft, command, args }));
  }

  protected async saveAndSay(): Promise<void> {
    if (await this.save()) this.toasts.notify('Saved', 'success');
  }

  private async save(): Promise<boolean> {
    try {
      const stored = await this.host.invoke<McpServerSummary>('mcp.server.save', { server: this.draft() });
      const def = definitionOf(stored);
      this.draft.set(def);
      this.commandLine.set(joinCommandLine(def.command, def.args));
      this.summary.reload();
      this.tabs.updateTab(this.scope(), this.tab().id, { title: stored.name });
      return true;
    } catch (err) {
      this.toasts.error(err);
      return false;
    }
  }

  protected async toggle(): Promise<void> {
    const summary = this.summary.value();
    if (!summary || this.busy()) return;
    this.busy.set(true);
    try {
      if (summary.status === 'disconnected') {
        if (this.dirty() && !(await this.save())) return;
        const opened = await this.host.invoke<McpServerSummary>('mcp.connect', { id: this.serverId() });
        if (opened.error && opened.status === 'disconnected') this.toasts.notify(opened.error, 'error');
      } else {
        await this.host.invoke('mcp.disconnect', { id: this.serverId() });
      }
      this.summary.reload();
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected async ping(): Promise<void> {
    try {
      const out = await this.host.invoke<{ durationMs: number }>('mcp.ping', { id: this.serverId() });
      this.toasts.notify(`Pong in ${formatMs(out.durationMs)}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }
}
