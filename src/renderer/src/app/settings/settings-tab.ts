import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { PALETTES, resolvePalette, type GlobalConfig, type TeleportStatus, type Variable } from '@quiver/core';
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
import { AboutPanel } from './about-panel';

type ThemePreference = GlobalConfig['theme'];

/** Settings: appearance, the MCP server, Teleport, global variables and About. Saved in the global config. */
@Component({
  selector: 'q-settings-tab',
  imports: [AboutPanel, Button, Checkbox, FormField, Input, KeyValueEditor, Label, NgTemplateOutlet, Select],
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

  protected toggleMcp(config: GlobalConfig, event: Event, key: 'enabled' | 'allowMutating'): void {
    void this.update({ mcp: { ...config.mcp, [key]: (event.target as HTMLInputElement).checked } });
  }

  protected savePort(config: GlobalConfig): void {
    const port = Number(this.fields().port);
    if (port !== config.mcp.port) void this.update({ mcp: { ...config.mcp, port } });
  }

  protected saveTshPath(config: GlobalConfig): void {
    const tshPath = this.fields().tshPath.trim();
    if (tshPath !== config.teleport.tshPath) void this.update({ teleport: { ...config.teleport, tshPath } });
  }

  protected toggleLoginOnLaunch(config: GlobalConfig, event: Event): void {
    void this.update({ teleport: { ...config.teleport, loginOnLaunch: (event.target as HTMLInputElement).checked } });
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

  protected copy(text: string): void {
    this.toasts.copy(text);
  }
}
