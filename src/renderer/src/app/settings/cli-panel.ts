import { NgTemplateOutlet } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Button, Label, Toasts, invokeResource } from '@quiver/ui';
import { Copy } from 'lucide';

/** What cli.status says: whether the command line can connect, and where the packaged shims are. */
interface CliStatus {
  connected: boolean;
  url: string | null;
  mcpEnabled: boolean;
  shims: string | null;
  pathLines: { shell: string; line: string }[];
  appImage: boolean;
}

/** Settings → Command line: the shim folder, a copyable line per shell to put it on PATH, and whether connected mode works. Nothing edits PATH. */
@Component({
  selector: 'q-cli-panel',
  imports: [Button, Label, NgTemplateOutlet],
  templateUrl: './cli-panel.html',
  host: { class: 'block', 'data-testid': 'settings-cli' },
})
export class CliPanel {
  private readonly toasts = inject(Toasts);

  protected readonly icons = { Copy };
  protected readonly status = invokeResource<CliStatus>('cli.status', () => ({}), { workspaceId: null, refreshOnEvents: ['mcp.status'] });
  protected readonly devCommand = 'npm run cli -- list';

  protected copy(text: string): void {
    this.toasts.copy(text);
  }
}
