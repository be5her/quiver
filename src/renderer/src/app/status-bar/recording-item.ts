import { Component, computed, inject } from '@angular/core';
import type { McpRecordingStatus } from '@quiver/core';
import { UiActions, invokeResource } from '@quiver/ui';

/** Shown while the calls agents make to the MCP server are being recorded, so a running recording is never out of sight. */
@Component({
  selector: 'q-recording-item',
  template: `
    @if (recording(); as recording) {
      <button type="button" class="flex items-center gap-1 hover:text-fg" [title]="title()" data-testid="mcp-recording-status" (click)="open()">
        <span class="size-1.5 rounded-full" [class]="paused() ? 'bg-warning' : 'bg-danger animate-pulse'"></span>REC {{ paused() ? 'paused' : recording.count }}</button>
    }
  `,
  host: { class: 'contents' },
})
export class RecordingItem {
  private readonly actions = inject(UiActions);
  private readonly status = invokeResource<McpRecordingStatus>('mcp.recording.status', () => ({}), { workspaceId: null, refreshOnEvents: ['mcp.recording'] });

  protected readonly recording = computed(() => {
    const status = this.status.value();
    return status?.state === 'recording' || status?.state === 'paused' ? status : null;
  });
  protected readonly paused = computed(() => this.recording()?.state === 'paused');
  protected readonly title = computed(() => `${this.paused() ? 'Recording of MCP calls is paused' : 'Recording MCP calls'}: ${this.recording()?.count ?? 0} so far. Click to open the recorder.`);

  protected open(): void {
    this.actions.run('mcp.recorder.open');
  }
}
