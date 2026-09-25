import type { CommandMeta, ErrorPayload, HostEventMessage } from '@quiver/core';

export type InvokeResult = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

/** The surface the Electron preload script exposes as `window.quiver`. Kept tiny on purpose. */
export interface QuiverBridge {
  invoke(id: string, input: unknown, workspaceId: string | null): Promise<InvokeResult>;
  listCommands(): Promise<CommandMeta[]>;
  onEvent(listener: (message: HostEventMessage) => void): () => void;
  platform: string;
  version: string;
}

declare global {
  interface Window {
    quiver: QuiverBridge;
  }
}
