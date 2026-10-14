import { DOCUMENT, DestroyRef, InjectionToken, Service, inject, untracked } from '@angular/core';
import { QuiverError, type CommandMeta, type HostEventMessage, type HostEventName, type HostEvents } from '@quiver/core';
import type { QuiverBridge } from '../bridge';
import { AppState } from '../state/app-state';

/** The three functions (plus platform and version) the Electron preload exposes as `window.quiver`. */
export const QUIVER_BRIDGE = new InjectionToken<QuiverBridge>('QuiverBridge', {
  providedIn: 'root',
  factory: () => inject(DOCUMENT).defaultView!.quiver,
});

type AnyListener = (message: HostEventMessage) => void;

/**
 * The renderer's only way to the host: commands by id, and the events the host broadcasts.
 * Every feature is a set of registry commands, so the palette, MCP and the UI share one path.
 */
@Service()
export class HostBridge {
  private readonly bridge = inject(QUIVER_BRIDGE);
  private readonly app = inject(AppState);
  private readonly listeners = new Set<AnyListener>();
  private attached = false;

  readonly platform = this.bridge.platform;
  readonly version = this.bridge.version;
  readonly isMac = this.bridge.platform === 'darwin';
  /** The modifier key as shortcuts are written on this platform. */
  readonly modKey = this.isMac ? '⌘' : 'Ctrl';

  /**
   * Run a host command. `workspaceId` defaults to the active workspace;
   * pass `null` to run a global command explicitly without one.
   */
  async invoke<T = unknown>(id: string, input: unknown = {}, workspaceId?: string | null): Promise<T> {
    const ws = workspaceId === undefined ? untracked(this.app.activeWorkspaceId) : workspaceId;
    const res = await this.bridge.invoke(id, input, ws);
    if (!res.ok) throw new QuiverError(res.error.code, res.error.message, res.error.details);
    return res.result as T;
  }

  listCommands(): Promise<CommandMeta[]> {
    return this.bridge.listCommands();
  }

  /** Listen to a host event; returns the function that stops listening. One IPC subscription fans out to every listener. */
  on<E extends HostEventName>(event: E, listener: (payload: HostEvents[E]) => void): () => void {
    if (!this.attached) {
      this.attached = true;
      this.bridge.onEvent((message) => {
        for (const l of [...this.listeners]) l(message);
      });
    }
    const wrapped: AnyListener = (message) => {
      if (message.event === event) listener(message.payload as HostEvents[E]);
    };
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
    };
  }
}

/** Listen to a host event for as long as the calling component, directive or service lives. */
export function injectHostEvent<E extends HostEventName>(event: E, listener: (payload: HostEvents[E]) => void): void {
  const off = inject(HostBridge).on(event, listener);
  inject(DestroyRef).onDestroy(off);
}
