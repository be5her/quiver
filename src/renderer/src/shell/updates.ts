import { toErrorPayload, type UpdateState } from '@quiver/core';
import { confirmDialog, invoke, notify, useAppStore, useTabsStore } from '@quiver/ui';

/** Keeps the store in step with the host and tells the user about outcomes they asked for. */
export function handleUpdateEvent(state: UpdateState): void {
  const prev = useAppStore.getState().update;
  useAppStore.getState().setUpdate(state);
  if (prev?.status === state.status) return;
  if (state.status === 'downloaded') {
    notify(`Quiver ${state.version} is ready. Restart to install it.`, 'success');
    return;
  }
  // Automatic checks stay quiet: the status bar shows what they found.
  if (state.trigger !== 'manual') return;
  if (state.status === 'available') notify(`Quiver ${state.version} is available.`, 'info');
  else if (state.status === 'none') notify(`Quiver ${state.current} is the latest version.`, 'success');
  else if (state.status === 'error') notify(`Update check failed: ${state.error ?? 'unknown error'}`, 'error');
}

export async function checkForUpdates(): Promise<void> {
  try {
    const state = await invoke<UpdateState>('app.update.check', {}, null);
    useAppStore.getState().setUpdate(state);
    if (!state.supported) notify(state.reason ?? 'Updates are not available in this build.', 'info');
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function downloadUpdate(): Promise<void> {
  try {
    const state = await invoke<UpdateState>('app.update.download', {}, null);
    useAppStore.getState().setUpdate(state);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

export async function installUpdate(): Promise<void> {
  const update = useAppStore.getState().update;
  const dirty = Object.values(useTabsStore.getState().scopes).some((s) => s.tabs.some((t) => t.dirty));
  const ok = await confirmDialog({
    title: `Restart Quiver to install ${update?.version ?? 'the update'}?`,
    message: dirty ? 'Some tabs have unsaved changes; they will be lost.' : 'Quiver closes, installs the update and opens again.',
    danger: dirty,
    confirmLabel: 'Restart now',
  });
  if (!ok) return;
  try {
    await invoke('app.update.install', {}, null);
  } catch (err) {
    notify(toErrorPayload(err).message, 'error');
  }
}

/** Links open in the system browser through the main process's window-open handler. */
export function openExternal(url: string | undefined): void {
  if (url) window.open(url, '_blank', 'noopener');
}
