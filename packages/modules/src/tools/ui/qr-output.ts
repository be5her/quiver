import { Component, computed, inject, input } from '@angular/core';
import { qrSvgPath, toErrorPayload } from '@quiver/core';
import { AppState, Button, HostBridge, Toasts, formatBytes } from '@quiver/ui';
import { Copy, Download } from 'lucide';

/** What `tools.qr.encode` returns. */
export interface QrResult {
  svg: string;
  modules: string[];
  version: number;
  size: number;
  errorCorrection: string;
  mode: string;
}

/**
 * The QR tool's output: the symbol drawn from its matrix, dark on a white tile in both themes so a phone can scan it
 * off the screen, the version line under it, Copy SVG and Save PNG.
 */
@Component({
  selector: 'q-qr-output',
  imports: [Button],
  template: `
    <div class="flex-1 min-h-0 overflow-auto flex flex-col items-center justify-center gap-3 p-4 rounded border border-edge bg-surface" data-testid="qr-output">
      <div class="rounded bg-white p-2 shadow-sm">
        <svg class="block size-72 max-w-full text-black" [attr.viewBox]="viewBox()" shape-rendering="crispEdges" role="img" [attr.aria-label]="'QR code, version ' + result().version" data-testid="qr-svg">
          <path fill="currentColor" [attr.d]="path()" />
        </svg>
      </div>
      <div class="text-xs text-muted" data-testid="qr-info">{{ info() }}</div>
      <div class="flex gap-2">
        <button qButton size="sm" [icon]="Copy" (click)="copySvg()" data-testid="qr-copy">Copy SVG</button>
        <button
          qButton
          size="sm"
          [icon]="Download"
          [disabled]="!app.hasWorkspace()"
          [title]="app.hasWorkspace() ? 'Save the code as a PNG image' : 'Open a workspace to save files'"
          (click)="savePng()"
          data-testid="qr-save"
        >
          Save PNG…
        </button>
      </div>
    </div>
  `,
  host: { class: 'flex flex-col flex-1 min-h-0' },
})
export class QrOutput {
  private readonly host = inject(HostBridge);
  private readonly toasts = inject(Toasts);
  protected readonly app = inject(AppState);
  protected readonly Copy = Copy;
  protected readonly Download = Download;

  readonly result = input.required<QrResult>();
  /** The quiet zone and module size the code was asked for, used for the PNG as for the SVG. */
  readonly margin = input(4);
  readonly moduleSize = input(8);

  private readonly side = computed(() => this.result().size + this.margin() * 2);
  protected readonly viewBox = computed(() => `0 0 ${this.side()} ${this.side()}`);
  protected readonly path = computed(() => qrSvgPath(this.result().modules, this.margin()));
  protected readonly info = computed(() => {
    const r = this.result();
    return `Version ${r.version} · ${r.size}×${r.size} modules · ${r.mode} · level ${r.errorCorrection}`;
  });

  protected copySvg(): void {
    this.toasts.copy(this.result().svg, 'SVG copied');
  }

  /** Draws the matrix onto a canvas, black on white, and writes it through the save dialog and the API module's file write. */
  protected async savePng(): Promise<void> {
    try {
      const picked = await this.host.invoke<{ path: string | null }>('app.pickSavePath', { title: 'Save QR code', defaultPath: 'qr-code.png', filters: [{ name: 'PNG image', extensions: ['png'] }] }, null);
      if (!picked.path) return;
      const saved = await this.host.invoke<{ path: string; bytes: number }>('api.response.save', { path: picked.path, body: this.png(), bodyEncoding: 'base64' });
      this.toasts.notify(`Saved ${formatBytes(saved.bytes)} to ${saved.path.split(/[\\/]/).pop()}`, 'success');
    } catch (err) {
      this.toasts.error(toErrorPayload(err).message);
    }
  }

  /** The PNG as base64, (size + 2 × margin) × module size pixels square. */
  png(): string {
    const { modules } = this.result();
    const scale = this.moduleSize();
    const margin = this.margin();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = this.side() * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    modules.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '1') ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    });
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  }
}
