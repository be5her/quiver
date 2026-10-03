import { Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';
import { describeMcpServer, transportLabel, type McpConfigFile, type McpServerSummary, type McpTransport } from '@quiver/core';
import { Button, Icon, IconButton, SectionHeader, Spinner, invokeResource } from '@quiver/ui';
import { Download, FileJson, Globe, Plug, Plus, Radio, Terminal, Trash2, Unplug } from 'lucide';
import { McpActions } from './mcp-actions';
import { TRANSPORT_COLOR, plural, recordingDot, statusDot } from './mcp-format';
import { McpRecording, injectRecordingStatus } from './mcp-recording';

/** Opens the recording of what agents call on Quiver's own server, and shows whether one is running. */
@Component({
  selector: 'q-mcp-recorder-row',
  template: `
    <span class="size-2 rounded-full shrink-0" [class]="dot()" [attr.aria-label]="state()"></span>
    <span class="truncate flex-1 text-[13px]">Call recorder</span>
    @if (status.value(); as s) {
      @if (state() !== 'idle') {
        <span class="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0" [title]="calls()">{{ s.count }}</span>
      }
    }
  `,
  host: {
    role: 'button',
    tabindex: '0',
    class: 'flex items-center gap-1.5 pl-3 pr-2 h-7 cursor-pointer hover:bg-elevated min-w-0',
    title: "Record the calls agents make to Quiver's own MCP server",
    'data-testid': 'mcp-recorder-row',
    '[attr.data-state]': 'state()',
    '(click)': 'recording.openRecorderTab()',
    '(keydown.enter)': 'recording.openRecorderTab()',
  },
})
export class McpRecorderRow {
  protected readonly recording = inject(McpRecording);

  protected readonly status = injectRecordingStatus();
  protected readonly state = computed(() => this.status.value()?.state ?? 'idle');
  protected readonly dot = computed(() => recordingDot(this.state()));
  protected readonly calls = computed(() => plural(this.status.value()?.count ?? 0, 'recorded call'));
}

/** The + of the Servers header: a new server of any transport, an import, or Quiver itself. */
@Component({
  selector: 'q-mcp-new-server-menu',
  imports: [Icon, IconButton],
  template: `
    <button qIconButton label="New server" size="sm" (click)="open.set(!open())"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    @if (open()) {
      <div class="absolute right-0 top-full mt-1 z-20 min-w-52 rounded-md border border-edge bg-elevated shadow-lg py-1 normal-case tracking-normal font-normal">
        <button type="button" [class]="item" (click)="pick('stdio')"><svg [qIcon]="icons.Terminal" class="size-3.5 text-muted"></svg> Command (stdio)</button>
        <button type="button" [class]="item" (click)="pick('http')"><svg [qIcon]="icons.Globe" class="size-3.5 text-muted"></svg> Streamable HTTP</button>
        <button type="button" [class]="item" (click)="pick('sse')"><svg [qIcon]="icons.Radio" class="size-3.5 text-muted"></svg> SSE (legacy)</button>
        <div class="border-t border-edge my-1"></div>
        <button type="button" [class]="item" (click)="pick('import')"><svg [qIcon]="icons.FileJson" class="size-3.5 text-muted"></svg> Import from .mcp.json</button>
        <button type="button" [class]="item" (click)="pick('self')"><svg [qIcon]="icons.Plug" class="size-3.5 text-muted"></svg> This Quiver</button>
      </div>
    }
  `,
  host: { class: 'relative block' },
})
export class McpNewServerMenu {
  private readonly mcp = inject(McpActions);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly icons = { FileJson, Globe, Plug, Plus, Radio, Terminal };
  protected readonly item = 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-fg hover:bg-surface';
  protected readonly open = signal(false);

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        if (!this.element.nativeElement.contains(e.target as Node)) this.open.set(false);
      };
      document.addEventListener('mousedown', onDown);
      onCleanup(() => document.removeEventListener('mousedown', onDown));
    });
  }

  protected pick(choice: McpTransport | 'import' | 'self'): void {
    this.open.set(false);
    if (choice === 'import') void this.mcp.importServers();
    else if (choice === 'self') void this.mcp.addThisQuiver();
    else void this.mcp.createServer(choice);
  }
}

/** One server: status, transport, name and tool count; connect and delete on hover. */
@Component({
  selector: 'q-mcp-server-row',
  imports: [Icon, IconButton],
  template: `
    @let s = server();
    <span class="size-2 rounded-full shrink-0" [class]="dot()" [attr.aria-label]="s.status"></span>
    <span class="text-[9px] font-bold w-8 shrink-0" [class]="transportColor[s.transport]">{{ transport() }}</span>
    <span class="truncate flex-1 text-[13px]">{{ s.name }}</span>
    @if (s.status === 'connected') {
      <span class="text-[10px] rounded-full bg-elevated px-1.5 text-muted shrink-0 group-hover:hidden" [title]="counts()">{{ s.toolCount }}</span>
    }
    <span class="hidden group-hover:flex items-center">
      <button qIconButton [label]="open() ? 'Disconnect' : 'Connect'" size="sm" (click)="toggle($event)"><svg [qIcon]="open() ? icons.Unplug : icons.Plug" class="size-3.5"></svg></button>
      <button qIconButton label="Delete server" size="sm" (click)="remove($event)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
    </span>
  `,
  host: {
    role: 'button',
    tabindex: '0',
    class: 'group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0',
    'data-testid': 'mcp-server',
    '[attr.title]': 'title()',
    '[attr.data-status]': 'server().status',
    '(click)': 'openTab()',
    '(keydown.enter)': 'openTab()',
  },
})
export class McpServerRow {
  private readonly mcp = inject(McpActions);

  readonly server = input.required<McpServerSummary>();

  protected readonly icons = { Plug, Trash2, Unplug };
  protected readonly transportColor = TRANSPORT_COLOR;
  protected readonly open = computed(() => this.server().status !== 'disconnected');
  protected readonly transport = computed(() => transportLabel(this.server().transport));
  protected readonly dot = computed(() => statusDot(this.server().status, this.server().error));
  protected readonly title = computed(() => this.server().error ?? `${describeMcpServer(this.server())} · ${this.server().status}`);
  protected readonly counts = computed(() => {
    const s = this.server();
    return `${s.toolCount} tools, ${s.resourceCount} resources, ${s.promptCount} prompts`;
  });

  protected openTab(): void {
    this.mcp.openServerTab(this.server());
  }

  protected toggle(event: Event): void {
    event.stopPropagation();
    void this.mcp.toggleServer(this.server());
  }

  protected remove(event: Event): void {
    event.stopPropagation();
    void this.mcp.deleteServer(this.server());
  }
}

/** A config file in the project that declares servers not imported yet. */
@Component({
  selector: 'q-mcp-config-file-row',
  imports: [Button, Icon],
  template: `
    @let f = file();
    <div class="flex items-center gap-1.5 min-w-0">
      <svg [qIcon]="icons.FileJson" class="size-3.5 text-muted shrink-0"></svg>
      <span class="font-mono text-xs truncate flex-1" [title]="f.file">{{ f.file }}</span>
      @if (!f.error) {
        <button qButton size="sm" variant="ghost" [icon]="icons.Download" data-testid="mcp-import" [title]="'Import ' + names()" (click)="mcp.importServers(f.file)">Import</button>
      }
    </div>
    @if (f.error) {
      <p class="text-[11px] text-danger truncate">{{ f.error }}</p>
    } @else {
      <p class="text-[11px] text-muted truncate">{{ names() }}</p>
    }
  `,
  host: { class: 'px-3 py-1.5 flex flex-col gap-1 min-w-0', 'data-testid': 'mcp-config-file' },
})
export class McpConfigFileRow {
  protected readonly mcp = inject(McpActions);

  readonly file = input.required<McpConfigFile>();

  protected readonly icons = { Download, FileJson };
  protected readonly names = computed(() =>
    this.file()
      .servers.filter((s) => !s.imported)
      .map((s) => s.name)
      .join(', '),
  );
}

/** Quiver's own call recorder, the project's MCP servers, and the ones its config files declare. */
@Component({
  selector: 'q-mcp-sidebar',
  imports: [Button, McpConfigFileRow, McpNewServerMenu, McpRecorderRow, McpServerRow, SectionHeader, Spinner],
  template: `
    <q-section-header title="This Quiver" />
    <q-mcp-recorder-row />
    <q-section-header title="Servers"><q-mcp-new-server-menu /></q-section-header>
    @if (servers.isLoading() && !servers.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (server of servers.value() ?? []; track server.id) {
      <q-mcp-server-row [server]="server" />
    }
    @if (servers.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2">
        <p class="text-xs text-muted">Connect to MCP servers, browse their tools, resources and prompts, call them and watch the JSON-RPC traffic.</p>
        <div class="flex gap-1 flex-wrap">
          <button qButton size="sm" variant="secondary" [icon]="icons.Terminal" (click)="mcp.createServer('stdio')">Command</button>
          <button qButton size="sm" variant="secondary" [icon]="icons.Globe" (click)="mcp.createServer('http')">HTTP</button>
          <button qButton size="sm" variant="secondary" [icon]="icons.Radio" title="Add Quiver's own MCP server for this workspace" (click)="mcp.addThisQuiver()">This Quiver</button>
        </div>
      </div>
    }
    @if (servers.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
    @if (pending().length > 0) {
      <q-section-header title="Found in project" />
      @for (file of pending(); track file.file) {
        <q-mcp-config-file-row [file]="file" />
      }
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class McpSidebar {
  protected readonly mcp = inject(McpActions);

  protected readonly icons = { Globe, Radio, Terminal };
  protected readonly servers = invokeResource<McpServerSummary[]>('mcp.server.list', () => ({}), { refreshOn: ['mcp-servers'], refreshOnEvents: ['mcp.changed'] });
  private readonly discovered = invokeResource<McpConfigFile[]>('mcp.server.discover', () => ({}), { refreshOn: ['mcp-servers'] });
  protected readonly pending = computed(() => (this.discovered.value() ?? []).filter((f) => f.error || f.servers.some((s) => !s.imported)));
}
