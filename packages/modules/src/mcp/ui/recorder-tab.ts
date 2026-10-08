import { Component, ElementRef, afterRenderEffect, computed, inject, input, signal, viewChild } from '@angular/core';
import { mcpAgentLabel, type McpRecordedCallSummary, type McpRecordingStatus } from '@quiver/core';
import { AppState, Badge, Button, Checkbox, EmptyState, Icon, IconButton, Input, Select, Spinner, formatBytes, formatMs, invokeResource, type Tab, type TabComponent } from '@quiver/ui';
import { ArrowDownToLine, Circle, Download, Pause, Play, Square, Trash2, TriangleAlert } from 'lucide';
import { McpCallDetail } from './call-detail';
import { agentColor, plural, recordingDot } from './mcp-format';
import { McpRecording } from './mcp-recording';

const IDLE: McpRecordingStatus = { state: 'idle', startedAt: null, endedAt: null, limitReached: false, count: 0, bytes: 0, savedTo: null };

const STATE_LABEL: Record<McpRecordingStatus['state'], string> = { idle: 'Not recording', recording: 'Recording', paused: 'Paused', ended: 'Ended' };

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '');

/** Every tool call agents make to Quiver's own MCP server between start and end, kept in memory until it is saved to a file. */
@Component({
  selector: 'q-mcp-recorder-tab',
  imports: [Badge, Button, Checkbox, EmptyState, Icon, IconButton, Input, McpCallDetail, Select, Spinner],
  templateUrl: './recorder-tab.html',
  host: { class: 'flex flex-col h-full min-h-0', 'data-testid': 'mcp-recorder', '[attr.data-state]': 'status().state' },
})
export class McpRecorderTab implements TabComponent {
  private readonly app = inject(AppState);
  protected readonly recorder = inject(McpRecording);
  private readonly list = viewChild<ElementRef<HTMLDivElement>>('list');

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly icons = { ArrowDownToLine, Circle, Download, Pause, Play, Square, Trash2, TriangleAlert };
  protected readonly stateLabel = STATE_LABEL;
  protected readonly time = time;
  protected readonly agentColor = agentColor;
  protected readonly agentLabel = mcpAgentLabel;
  protected readonly formatBytes = formatBytes;
  protected readonly formatMs = formatMs;

  private readonly recording = invokeResource<{ status: McpRecordingStatus; calls: McpRecordedCallSummary[] }>('mcp.recording.list', () => ({}), {
    workspaceId: null,
    refreshOnEvents: ['mcp.recording'],
  });
  protected readonly server = this.app.mcpStatus;
  protected readonly selectedId = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly agent = signal('');
  protected readonly failedOnly = signal(false);
  /** Whether the list sticks to the newest call; scrolling up stops it. */
  protected readonly follow = signal(true);

  protected readonly status = computed(() => this.recording.value()?.status ?? IDLE);
  protected readonly calls = computed(() => this.recording.value()?.calls ?? []);
  protected readonly agents = computed(() => [...new Set(this.calls().map((c) => c.agent.name))].sort());
  protected readonly filtered = computed(() => {
    const needle = this.filter().trim().toLowerCase();
    const agent = this.agent();
    const failedOnly = this.failedOnly();
    return this.calls().filter(
      (c) => (!agent || c.agent.name === agent) && (!failedOnly || c.ok === false) && (!needle || `${c.tool} ${mcpAgentLabel(c.agent)} ${c.workspace?.name ?? ''} ${c.preview}`.toLowerCase().includes(needle)),
    );
  });
  protected readonly selected = computed(() => this.calls().find((c) => c.id === this.selectedId()) ?? null);
  protected readonly active = computed(() => this.status().state === 'recording' || this.status().state === 'paused');
  protected readonly dot = computed(() => recordingDot(this.status().state));
  protected readonly summary = computed(() => {
    const s = this.status();
    return `${plural(s.count, 'call')} · ${formatBytes(s.bytes)} · ${time(s.startedAt)}${s.endedAt ? ` – ${time(s.endedAt)}` : ''}`;
  });
  protected readonly waitingHint = computed(() =>
    this.status().state === 'paused' ? 'Calls that arrive now are not kept. Resume to go on.' : `Agents reach Quiver at http://127.0.0.1:${this.server()?.port ?? 7411}/mcp. Their calls show up here as they arrive.`,
  );

  constructor() {
    afterRenderEffect({
      write: () => {
        this.calls().length;
        if (!this.follow()) return;
        const el = this.list()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      },
    });
  }

  protected typed(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
  }

  protected pickAgent(event: Event): void {
    this.agent.set((event.target as HTMLSelectElement).value);
  }

  protected toggleFailed(event: Event): void {
    this.failedOnly.set((event.target as HTMLInputElement).checked);
  }

  protected scrolled(): void {
    const el = this.list()?.nativeElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== this.follow()) this.follow.set(atBottom);
  }

  protected pick(id: string): void {
    this.selectedId.update((current) => (current === id ? null : id));
  }
}
