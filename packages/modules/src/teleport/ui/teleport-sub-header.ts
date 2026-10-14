import { Component, booleanAttribute, input, output } from '@angular/core';
import { Icon, IconButton } from '@quiver/ui';
import { RefreshCw } from 'lucide';

/** "Databases" or "Kubernetes" inside a cluster, with its refresh button. */
@Component({
  selector: 'q-teleport-sub-header',
  imports: [Icon, IconButton],
  template: `<span>{{ title() }}</span><button qIconButton [label]="'Refresh ' + title().toLowerCase()" size="sm" (click)="refresh.emit()"><svg [qIcon]="refreshIcon" class="size-3" [class.animate-spin]="loading()"></svg></button>`,
  host: { class: 'flex items-center justify-between pl-4 pr-2 h-6 text-[10px] font-semibold uppercase tracking-wide text-muted' },
})
export class TeleportSubHeader {
  readonly title = input.required<string>();
  readonly loading = input(false, { transform: booleanAttribute });
  readonly refresh = output<void>();

  protected readonly refreshIcon = RefreshCw;
}
