import { ipcMain } from 'electron';
import type { Host } from './host';

interface InvokePayload {
  id: string;
  input: unknown;
  workspaceId: string | null;
}

export function registerIpc(host: Host): void {
  ipcMain.handle('quiver:invoke', (_event, payload: InvokePayload) =>
    host.invoke(payload.id, payload.input, { caller: 'ui', workspaceId: payload.workspaceId }),
  );
  ipcMain.handle('quiver:commands', () => host.registry.list());
}
