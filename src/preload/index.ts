import type { QuiverBridge } from '@quiver/ui/bridge';
import { contextBridge, ipcRenderer } from 'electron';
import type { HostEventMessage } from '../../packages/core/src/types';

/**
 * The only bridge between renderer and main. Modules never touch IPC directly:
 * they call commands by id, and the host routes them through the registry.
 */
const bridge: QuiverBridge = {
  invoke: (id: string, input: unknown, workspaceId: string | null) => ipcRenderer.invoke('quiver:invoke', { id, input, workspaceId }),
  listCommands: () => ipcRenderer.invoke('quiver:commands'),
  onEvent: (listener: (message: HostEventMessage) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: HostEventMessage) => listener(message);
    ipcRenderer.on('quiver:event', wrapped);
    return () => ipcRenderer.removeListener('quiver:event', wrapped);
  },
  platform: process.platform,
  version: process.env.QUIVER_VERSION ?? '0.0.0',
};

contextBridge.exposeInMainWorld('quiver', bridge);
