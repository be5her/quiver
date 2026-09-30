import { toErrorPayload, type McpRecordingStatus } from '@quiver/core';
import { confirmDialog, invoke, notify, selectScope, useAppStore, useInvoke, useTabsStore, type UseInvokeResult } from '@quiver/ui';

export const RECORDER_TAB = 'mcp.recorder';

/** The recorder belongs to the app, not to a workspace, so it opens in whichever scope is on screen. */
export function openRecorderTab(): void {
  const scope = selectScope(useAppStore.getState());
  useTabsStore.getState().openTab(scope, { type: RECORDER_TAB, title: 'Call recorder', data: { key: 'recorder' } }, { singletonKey: `${RECORDER_TAB}:recorder` });
}

export function useRecordingStatus(): UseInvokeResult<McpRecordingStatus> {
  return useInvoke<McpRecordingStatus>('mcp.recording.status', {}, { workspaceId: null, refreshOnEvents: ['mcp.recording'] });
}

async function control(action: 'start' | 'pause' | 'resume' | 'end' | 'clear'): Promise<void> {
  try {
    await invoke(`mcp.recording.${action}`, {}, null);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export const pauseRecording = () => control('pause');
export const resumeRecording = () => control('resume');
export const endRecording = () => control('end');

/** True when dropping the recording loses nothing, or the user agreed to lose it. */
async function mayDrop(status: McpRecordingStatus, title: string): Promise<boolean> {
  if (status.count === 0 || status.savedTo) return true;
  const calls = `${status.count} recorded call${status.count === 1 ? '' : 's'}`;
  return confirmDialog({ title, message: `${calls} only exist in memory and have not been saved to a file.`, danger: true, confirmLabel: 'Discard' });
}

/** Starts a new recording; one that is already running is left alone. */
export async function startRecording(): Promise<void> {
  try {
    const status = await invoke<McpRecordingStatus>('mcp.recording.status', {}, null);
    if (status.state === 'recording' || status.state === 'paused') return;
    if (await mayDrop(status, 'Start a new recording?')) await control('start');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function discardRecording(status: McpRecordingStatus): Promise<void> {
  if (await mayDrop(status, 'Discard the recording?')) await control('clear');
}

export async function saveRecording(): Promise<void> {
  try {
    const saved = await invoke<{ path: string; calls: number } | null>('mcp.recording.save', {}, null);
    if (saved) notify(`Saved ${saved.calls} call${saved.calls === 1 ? '' : 's'} to ${saved.path}`, 'success');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}
