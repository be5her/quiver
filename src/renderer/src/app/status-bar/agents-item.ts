import { Component, computed, inject } from '@angular/core';
import { AppState, Icon } from '@quiver/ui';
import { Bot, Pause, Play } from 'lucide';
import { AgentsState } from '../agents/agents-state';

/** Agent calls in the last minute and the approvals waiting, which open the Agent activity tab, plus the Pause agents switch. */
@Component({
  selector: 'q-agents-item',
  imports: [Icon],
  template: `
    @if (enabled()) {
      <button
        type="button"
        class="flex items-center gap-1 hover:text-fg"
        [class]="agents.paused() ? 'text-warning' : agents.pending().length ? 'text-warning font-medium' : ''"
        [title]="title()"
        data-testid="agent-activity-status"
        [attr.data-pending]="agents.pending().length"
        [attr.data-calls]="agents.lastMinute()"
        [attr.data-paused]="agents.paused()"
        (click)="agents.openTab()"
      >
        <svg [qIcon]="icons.Bot" class="size-3"></svg>
        @if (agents.paused()) {
          Agents paused
        } @else {
          {{ agents.lastMinute() }}/min
        }
        @if (agents.pending().length; as waiting) {
          <span class="rounded bg-warning/15 px-1 animate-pulse">{{ waiting }} waiting</span>
        }
      </button>
      <button
        type="button"
        class="flex items-center hover:text-fg"
        [title]="agents.paused() ? 'Resume agents: let MCP calls through again' : 'Pause agents: refuse every MCP call until resumed'"
        data-testid="agent-pause-toggle"
        (click)="agents.setPaused(!agents.paused())"
      >
        <svg [qIcon]="agents.paused() ? icons.Play : icons.Pause" class="size-3"></svg>
      </button>
    }
  `,
  host: { class: 'contents' },
})
export class AgentsItem {
  private readonly app = inject(AppState);
  protected readonly agents = inject(AgentsState);
  protected readonly icons = { Bot, Pause, Play };

  protected readonly enabled = computed(() => this.app.config()?.mcp.enabled ?? false);
  protected readonly title = computed(() => {
    const waiting = this.agents.pending().length;
    const head = this.agents.paused() ? 'Agents are paused: every MCP call is refused.' : `${this.agents.lastMinute()} agent calls in the last minute.`;
    return `${head}${waiting ? ` ${waiting} waiting for your answer.` : ''} Click for the agent activity.`;
  });
}
