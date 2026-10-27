import { Component, computed, inject, input } from '@angular/core';
import { describeLogsConnection, type LogsConnectionSummary } from '@quiver/core';
import { Button, Icon, IconButton, SectionHeader, Spinner, invokeResource } from '@quiver/ui';
import { Plus, Trash2 } from 'lucide';
import { LogsActions } from './logs-actions';
import { connectionStateLabel, sessionDot } from './logs-format';

/** One connection: sign-in state, name and data source; delete on hover. */
@Component({
  selector: 'q-logs-connection-row',
  imports: [Icon, IconButton],
  template: `
    @let c = conn();
    <span class="size-2 rounded-full shrink-0" [class]="dot()" [attr.aria-label]="c.session.state"></span>
    <span class="truncate flex-1 min-w-0 text-[13px]">{{ c.name }}</span>
    @if (c.kind === 'victorialogs') {
      <span class="truncate text-[11px] max-w-[45%] group-hover:hidden" [class]="c.session.state === 'signed-out' ? 'text-danger' : 'text-muted'" data-testid="logs-connection-kind">{{ c.session.state === 'signed-out' ? 'unreachable' : 'direct' }}</span>
    } @else if (c.datasourceName && c.datasourceName !== c.name) {
      <span class="truncate text-[11px] text-muted max-w-[45%] group-hover:hidden">{{ c.datasourceName }}</span>
    }
    <span class="hidden group-hover:flex items-center">
      <button qIconButton label="Delete connection" size="sm" (click)="remove($event)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
    </span>
  `,
  host: {
    role: 'button',
    tabindex: '0',
    class: 'group flex items-center gap-1.5 pl-3 pr-1 h-7 cursor-pointer hover:bg-elevated min-w-0',
    'data-testid': 'logs-connection',
    '[attr.title]': 'title()',
    '[attr.data-session]': 'conn().session.state',
    '[attr.data-kind]': 'conn().kind',
    '(click)': 'logs.openConnectionTab(conn())',
    '(keydown.enter)': 'logs.openConnectionTab(conn())',
  },
})
export class LogsConnectionRow {
  protected readonly logs = inject(LogsActions);

  readonly conn = input.required<LogsConnectionSummary>();

  protected readonly icons = { Trash2 };
  protected readonly dot = computed(() => sessionDot(this.conn().session));
  protected readonly title = computed(() => {
    const c = this.conn();
    const direct = c.kind === 'victorialogs';
    return [describeLogsConnection(c) || (direct ? 'No VictoriaLogs address yet' : 'No Grafana address yet'), direct ? `Direct · ${connectionStateLabel(c)}` : `Through Grafana · ${connectionStateLabel(c)}`].join('\n');
  });

  protected remove(event: Event): void {
    event.stopPropagation();
    void this.logs.deleteConnection(this.conn());
  }
}

/** The project's VictoriaLogs connections. */
@Component({
  selector: 'q-logs-sidebar',
  imports: [Button, Icon, IconButton, LogsConnectionRow, SectionHeader, Spinner],
  template: `
    <q-section-header title="Connections">
      <button qIconButton label="New logs connection" size="sm" data-testid="logs-new" (click)="logs.createConnection()"><svg [qIcon]="icons.Plus" class="size-3.5"></svg></button>
    </q-section-header>
    @if (connections.isLoading() && !connections.value()) {
      <div class="px-3 py-2"><svg qSpinner></svg></div>
    }
    @for (conn of connections.value() ?? []; track conn.id) {
      <q-logs-connection-row [conn]="conn" />
    }
    @if (connections.value()?.length === 0) {
      <div class="px-3 py-2 flex flex-col gap-2">
        <p class="text-xs text-muted">Search VictoriaLogs through your Grafana (sign in once with the account you use in the browser; Google and other SSO work), or talk to a VictoriaLogs server directly.</p>
        <div><button qButton size="sm" variant="secondary" [icon]="icons.Plus" (click)="logs.createConnection()">New connection</button></div>
      </div>
    }
    @if (connections.error(); as error) {
      <p class="px-3 py-2 text-xs text-danger">{{ error.message }}</p>
    }
  `,
  host: { class: 'flex flex-col h-full min-h-0 overflow-y-auto text-sm' },
})
export class LogsSidebar {
  protected readonly logs = inject(LogsActions);

  protected readonly icons = { Plus };
  protected readonly connections = invokeResource<LogsConnectionSummary[]>('logs.connection.list', () => ({}), {
    refreshOn: ['logs-connections'],
    refreshOnEvents: ['logs.changed'],
  });
}
