import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between renderer and main. Modules never touch IPC directly:
 * they call commands by id, and the host routes them through the registry.
 */
const bridge = {
  invoke: (id: string, input: unknown, workspaceId: string | null) => ipcRenderer.invoke('quiver:invoke', { id, input, workspaceId }),
  listCommands: () => ipcRenderer.invoke('quiver:commands'),
  onEvent: (listener: (message: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message);
    ipcRenderer.on('quiver:event', wrapped);
    return () => ipcRenderer.removeListener('quiver:event', wrapped);
  },
  platform: process.platform,
  version: process.env.QUIVER_VERSION ?? '0.0.0',
};

contextBridge.exposeInMainWorld('quiver', bridge);
