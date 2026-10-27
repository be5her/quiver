import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, linkedSignal, signal, untracked } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { PALETTES, isAutoRenewOn, resolvePalette, workspaceRulesFor, type AgentPermissionMode, type AgentPermissionRule, type AgentRuleAction, type GlobalConfig, type TeleportStatus, type Variable } from '@quiver/core';
import {
  AppState,
  Button,
  Checkbox,
  HostBridge,
  Input,
  KeyValueEditor,
  Label,
  Select,
  Theme,
  Toasts,
  invokeResource,
  type Tab,
  type TabComponent,
} from '@quiver/ui';
import { Copy, X } from 'lucide';
import { AgentRulesEditor } from '../agents/rules-editor';
import { AboutPanel } from './about-panel';
import { CliPanel } from './cli-panel';

type ThemePreference = GlobalConfig['theme'];

/** The proxy settings as api.network.get gives them: the password only as whether one is kept. */
interface NetworkView {
  proxy: 'none' | 'system' | 'manual';
  url: string;
  noProxy: string[];
  username: string;
  hasPassword: boolean;
}

/** Settings: appearance, the MCP server and agent permissions, the command line, Teleport, the network, global variables and About. Saved in the global config. */
@Component({
  selector: 'q-settings-tab',
  imports: [AboutPanel, AgentRulesEditor, Button, CliPanel, Checkbox, FormField, Input, KeyValueEditor, Label, NgTemplateOutlet, Select],
  templateUrl: './settings-tab.html',
  host: { class: 'flex-1 overflow-auto p-6' },
})
export class SettingsTab implements TabComponent {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly theme = inject(Theme);
  private readonly toasts = inject(Toasts);

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { Copy, X };
  protected readonly palettes = PALETTES;
  protected readonly variableSyntax = '{{name}}';
  protected readonly config = this.app.config;
  protected readonly mcp = this.app.mcpStatus;
  protected readonly workspace = this.app.activeWorkspace;
  /** The active workspace's own agent rules, kept in the global config on this machine. */
  protected readonly workspaceRules = computed<AgentPermissionRule[]>(() => workspaceRulesFor(this.config()?.mcp ?? { workspaceRules: {} }, this.workspace()?.id));
  protected readonly teleport = invokeResource<TeleportStatus>('teleport.status', () => ({}), { workspaceId: null, refreshOnEvents: ['teleport.changed'] });

  /** Fields saved when they lose focus; they follow the stored values whenever the config changes. */
  protected readonly fields = linkedSignal(() => ({ port: this.config()?.mcp.port ?? 0, tshPath: this.config()?.teleport.tshPath ?? '' }));
  protected readonly fieldsForm = form(this.fields);
  protected readonly cluster = signal({ proxy: '' });
  protected readonly clusterForm = form(this.cluster);
  /**
   * Unsaved edits to the global variables survive other config changes (the theme, a variable edited
   * from its hover card); an untouched list follows the stored one.
   */
  protected readonly globals = linkedSignal<Variable[] | undefined, Variable[]>({
    source: () => this.config()?.globalVariables,
    computation: (stored, previous) => (!previous || JSON.stringify(previous.value) === JSON.stringify(previous.source) ? (stored ?? []) : previous.value),
  });
  private readonly storedNetwork = invokeResource<NetworkView>('api.network.get', () => ({}), { workspaceId: null, refreshOnEvents: ['config.changed'] });
  /** The proxy settings being edited; they follow the stored ones until changed. */
  protected readonly network = linkedSignal<NetworkView | undefined, NetworkView>({
    source: () => this.storedNetwork.value(),
    computation: (stored, previous) =>
      !previous || previous.source === undefined || JSON.stringify(previous.value) === JSON.stringify(previous.source) ? (stored ??{ proxy: 'none', url: '', noProxy: [], username: '', hasPassword: false }) : previous.value,
  });
  /** Typed only to change it; the stored one is never shown. */
  protected readonly proxyPassword = signal('');
  protected readonly networkChanged = computed(() => Boolean(this.proxyPassword()) || JSON.stringify(this.network()) !== JSON.stringify(this.storedNetwork.value()));
  protected readonly globalsChanged = computed(() => JSON.stringify(this.globals()) !== JSON.stringify(this.config()?.globalVariables));
  protected readonly selectedPalette = computed(() => resolvePalette(this.config()?.palette).key);
  protected readonly httpUrl = computed(() => `http://127.0.0.1:${this.config()?.mcp.port}/mcp`);
  protected readonly snippet = computed(() => `claude mcp add --transport http quiver "${this.httpUrl()}"`);
  protected readonly tshNote = computed(() => {
    const status = this.teleport.value();
    if (status?.tsh) return `using ${status.tsh.join(' ')}${status.tshVersion ? ` (v${status.tshVersion})` : ''}`;
    return status ? 'tsh not found' : '';
  });

  protected async update(patch: Partial<GlobalConfig>): Promise<void> {
    try {
      await this.host.invoke('config.update', { patch }, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected setTheme(event: Event): void {
    const theme = (event.target as HTMLSelectElement).value as ThemePreference;
    this.theme.apply(theme);
    void this.update({ theme });
  }

  protected setPalette(config: GlobalConfig, key: string): void {
    this.theme.apply(config.theme, key);
    void this.update({ palette: key });
  }

  protected toggleMcp(config: GlobalConfig, event: Event): void {
    // Only the field that changed: the host merges it, so a rule or a pause written since this view last read the
    // config is not undone by an older copy of the section.
    void this.update({ mcp: { enabled: (event.target as HTMLInputElement).checked } } as Partial<GlobalConfig>);
  }

  // The host applies each change to the permissions it holds, so two quick changes (a rule added, then the mode
  // picked) never undo one another the way a whole section written back from this view could.
  protected setMode(mode: AgentPermissionMode): void {
    this.host.invoke('mcp.permissions.setMode', { mode }, null).catch((err) => this.toasts.error(err));
  }

  protected setRule(level: 'global' | 'workspace', change: { match: string; action: AgentRuleAction | null }): void {
    this.host
      .invoke('mcp.permissions.setRule', { level, ...change }, level === 'global' ? null : (untracked(this.workspace)?.id ?? null))
      .catch((err) => this.toasts.error(err));
  }

  protected setPaused(event: Event): void {
    this.host.invoke('mcp.pause', { paused: (event.target as HTMLInputElement).checked }, null).catch((err) => this.toasts.error(err));
  }

  protected savePort(config: GlobalConfig): void {
    const port = Number(this.fields().port);
    if (port !== config.mcp.port) void this.update({ mcp: { port } } as Partial<GlobalConfig>);
  }

  protected saveTshPath(config: GlobalConfig): void {
    const tshPath = this.fields().tshPath.trim();
    if (tshPath !== config.teleport.tshPath) void this.update({ teleport: { ...config.teleport, tshPath } });
  }

  protected toggleLoginOnLaunch(config: GlobalConfig, event: Event): void {
    void this.update({ teleport: { ...config.teleport, loginOnLaunch: (event.target as HTMLInputElement).checked } });
  }

  protected isAutoRenew(config: GlobalConfig, proxy: string): boolean {
    return isAutoRenewOn(config.teleport, proxy);
  }

  protected toggleAutoRenew(proxy: string, event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    this.host.invoke('teleport.cluster.autoRenew', { proxy, enabled }, null).catch((err) => this.toasts.error(err));
  }

  protected toggleAgentsOnProtected(config: GlobalConfig, event: Event): void {
    void this.update({ teleport: { ...config.teleport, agentActionsOnProtected: (event.target as HTMLInputElement).checked } });
  }

  protected async addCluster(): Promise<void> {
    const proxy = this.cluster().proxy.trim();
    if (!proxy) return;
    try {
      await this.host.invoke('teleport.cluster.add', { proxy }, null);
      this.cluster.set({ proxy: '' });
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected removeCluster(proxy: string): void {
    this.host.invoke('teleport.cluster.remove', { proxy }, null).catch((err) => this.toasts.error(err));
  }

  protected async saveGlobals(): Promise<void> {
    await this.update({ globalVariables: this.globals() });
    this.toasts.notify('Global variables saved', 'success');
  }

  protected splitHosts(text: string): string[] {
    return text
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
  }

  protected setNetwork(patch: Partial<NetworkView>): void {
    this.network.update((n) => ({ ...n, ...patch }));
  }

  protected async saveNetwork(): Promise<void> {
    const n = this.network();
    try {
      await this.host.invoke('api.network.save', { proxy: n.proxy, url: n.url, noProxy: n.noProxy.map((h) => h.trim()).filter(Boolean), username: n.username, ...(this.proxyPassword() ? { password: this.proxyPassword() } : {}) }, null);
      this.proxyPassword.set('');
      this.storedNetwork.reload();
      this.toasts.notify('Network settings saved', 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  protected copy(text: string): void {
    this.toasts.copy(text);
  }
}
