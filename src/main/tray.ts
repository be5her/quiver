import { Menu, Tray, nativeImage } from 'electron';

/** What the tray menu shows about the host. */
export interface TrayStatus {
  mcpEnabled: boolean;
  listening: boolean;
  url: string;
  /** Agent calls waiting for the user to allow or deny them. */
  pending: number;
}

/**
 * The tray icon Quiver keeps while it runs in the background: open the window, see whether agents can reach the
 * MCP server and whether calls wait for approval, and quit. Never created in smoke runs.
 */
export class BackgroundTray {
  private tray: Tray | null = null;

  constructor(
    private readonly opts: {
      icon: string;
      status(): TrayStatus;
      open(): void;
      quit(): void;
    },
  ) {}

  get shown(): boolean {
    return this.tray !== null;
  }

  show(): void {
    if (this.tray) return this.refresh();
    const size = process.platform === 'darwin' ? 16 : 32;
    this.tray = new Tray(nativeImage.createFromPath(this.opts.icon).resize({ width: size, height: size }));
    // Windows and Linux open the window on a click; macOS shows the menu, as tray icons there do.
    if (process.platform !== 'darwin') {
      this.tray.on('click', () => this.opts.open());
      this.tray.on('double-click', () => this.opts.open());
    }
    this.refresh();
  }

  hide(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  refresh(): void {
    if (!this.tray) return;
    const { mcpEnabled, listening, url, pending } = this.opts.status();
    const mcpLine = !mcpEnabled ? 'MCP server is off' : listening ? `MCP listening on ${url}` : `MCP not listening (${url})`;
    this.tray.setToolTip(`Quiver: ${mcpLine}${pending ? `, ${pending} waiting for approval` : ''}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Quiver', click: () => this.opts.open() },
        { type: 'separator' },
        { label: mcpLine, enabled: false },
        pending
          ? { label: `${pending} agent call${pending === 1 ? '' : 's'} waiting for approval`, click: () => this.opts.open() }
          : { label: 'No agent calls waiting', enabled: false },
        { type: 'separator' },
        { label: 'Quit Quiver', click: () => this.opts.quit() },
      ]),
    );
  }
}
