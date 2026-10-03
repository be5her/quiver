import { Service, inject, untracked } from '@angular/core';
import type { McpRecordingStatus } from '@quiver/core';
import { AppState, Dialogs, HostBridge, TabsState, Toasts, invokeResource, type InvokeResource } from '@quiver/ui';

export const RECORDER_TAB = 'mcp.recorder';

/** The recorder's state, shared by the sidebar row and anything else that shows it. Call in an injection context. */
export function injectRecordingStatus(): InvokeResource<McpRecordingStatus> {
  return invokeResource<McpRecordingStatus>('mcp.recording.status', () => ({}), { workspaceId: null, refreshOnEvents: ['mcp.recording'] });
}

/** Starts, pauses, ends, saves and drops the recording of what agents call on Quiver's own MCP server. */
@Service()
export class McpRecording {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly dialogs = inject(Dialogs);
  private readonly toasts = inject(Toasts);

  /** The recorder belongs to the app, not to a workspace, so it opens in whichever scope is on screen. */
  openRecorderTab(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: RECORDER_TAB, title: 'Call recorder', data: { key: 'recorder' } }, { singletonKey: `${RECORDER_TAB}:recorder` });
  }

  /** Starts a new recording; one that is already running is left alone. */
  async start(): Promise<void> {
    try {
      const status = await this.host.invoke<McpRecordingStatus>('mcp.recording.status', {}, null);
      if (status.state === 'recording' || status.state === 'paused') return;
      if (await this.mayDrop(status, 'Start a new recording?')) await this.control('start');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  pause(): Promise<void> {
    return this.control('pause');
  }

  resume(): Promise<void> {
    return this.control('resume');
  }

  end(): Promise<void> {
    return this.control('end');
  }

  async discard(status: McpRecordingStatus): Promise<void> {
    if (await this.mayDrop(status, 'Discard the recording?')) await this.control('clear');
  }

  async save(): Promise<void> {
    try {
      const saved = await this.host.invoke<{ path: string; calls: number } | null>('mcp.recording.save', {}, null);
      if (saved) this.toasts.notify(`Saved ${saved.calls} call${saved.calls === 1 ? '' : 's'} to ${saved.path}`, 'success');
    } catch (err) {
      this.toasts.error(err);
    }
  }

  private async control(action: 'start' | 'pause' | 'resume' | 'end' | 'clear'): Promise<void> {
    try {
      await this.host.invoke(`mcp.recording.${action}`, {}, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  /** True when dropping the recording loses nothing, or the user agreed to lose it. */
  private async mayDrop(status: McpRecordingStatus, title: string): Promise<boolean> {
    if (status.count === 0 || status.savedTo) return true;
    const calls = `${status.count} recorded call${status.count === 1 ? '' : 's'}`;
    return this.dialogs.confirm({ title, message: `${calls} only exist in memory and have not been saved to a file.`, danger: true, confirmLabel: 'Discard' });
  }
}
