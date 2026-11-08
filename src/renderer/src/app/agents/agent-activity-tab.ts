import { Component, computed, inject, input } from '@angular/core';
import type { AgentActivityEntry } from '@quiver/core';
import { Badge, Button, Checkbox, EmptyState, UiActions, formatMs, type Tab, type TabComponent } from '@quiver/ui';
import { AgentsState, DECISION_LABEL } from './agents-state';

/** The Agent activity tab: the calls waiting for approval, the last 200 MCP calls, and the Pause agents switch. */
@Component({
  selector: 'q-agent-activity-tab',
  imports: [Badge, Button, Checkbox, EmptyState],
  template: `
    <div class="flex items-center gap-3 px-3 h-10 border-b border-edge shrink-0">
      <span class="text-sm font-medium">Agent activity</span>
      <span class="text-xs text-muted">{{ agents.lastMinute() }} calls in the last minute · the last {{ agents.calls().length }} kept, without arguments</span>
      <div class="flex-1"></div>
      @if (agents.grants().length) {
        <button qButton size="sm" variant="ghost" data-testid="agent-grants-clear" [title]="grantsTitle()" (click)="agents.clearGrants()">Forget {{ agents.grants().length }} allowed until restart</button>
      }
      <button qButton size="sm" variant="ghost" (click)="actions.run('settings.open')">Permissions…</button>
      <label class="flex items-center gap-1.5 text-xs" [class]="agents.paused() ? 'text-warning' : 'text-muted'"
        ><input type="checkbox" qCheckbox data-testid="agent-activity-pause" [checked]="agents.paused()" (change)="agents.setPaused($any($event.target).checked)" />Pause agents</label
      >
    </div>
    @if (agents.pending().length) {
      <div class="border-b border-edge shrink-0" data-testid="agent-activity-pending">
        <p class="px-3 pt-2 pb-1 text-[11px] font-medium text-warning">Waiting for your answer</p>
        @for (p of agents.pending(); track p.id) {
          <div class="flex items-center gap-2 px-3 py-1 text-xs" data-testid="agent-pending-row" [attr.data-tool]="p.commandId">
            <span class="w-28 truncate font-medium">{{ p.agent.name }}</span>
            <code class="font-mono truncate">{{ p.commandId }}</code>
            @if (p.action) {
              <code class="font-mono text-muted shrink-0">· {{ p.action }}</code>
            }
            <span class="text-muted truncate">{{ p.workspace?.name ?? '' }}</span>
            <div class="flex-1"></div>
            <button qButton size="sm" variant="ghost" (click)="agents.respond(p, 'deny')">Deny</button>
            <button qButton size="sm" variant="primary" (click)="agents.respond(p, 'once')">Allow once</button>
          </div>
        }
      </div>
    }
    @if (agents.calls().length === 0) {
      <q-empty-state
        title="No agent has called Quiver yet"
        hint="Every tool call an agent makes to Quiver's MCP server shows here as it happens: the agent, the tool, the workspace, what the permissions decided and how it went. Arguments and results are not kept; record the calls in the MCP inspector for those."
      />
    } @else {
      <div class="flex-1 overflow-y-auto" data-testid="agent-activity-list">
        @for (c of agents.calls(); track c.id) {
          <div class="px-3 py-1 border-b border-edge/60 flex items-center gap-2 min-w-0 text-xs" data-testid="agent-activity-row" [attr.data-tool]="c.tool" [attr.data-decision]="c.decision" [attr.data-agent]="c.agent.name" [attr.data-action]="c.action ?? ''">
            <span class="text-[10px] text-muted shrink-0 w-16 whitespace-nowrap">{{ time(c.at) }}</span>
            <span class="text-[11px] font-medium shrink-0 w-28 truncate" [title]="c.agent.version ? c.agent.name + ' ' + c.agent.version : c.agent.name">{{ c.agent.name }}</span>
            <span class="font-mono shrink-0 max-w-64 truncate" [title]="c.action ? c.tool + '#' + c.action : c.tool">{{ c.tool }}</span>
            @if (c.action) {
              <span class="font-mono shrink-0 text-muted" data-testid="agent-activity-action">· {{ c.action }}</span>
            }
            <span class="text-muted truncate flex-1">{{ c.workspace?.name ?? '' }}</span>
            <span class="w-20 shrink-0 text-[11px]" [class]="decision(c).color">{{ decision(c).label }}</span>
            <span qBadge class="shrink-0" [class]="c.ok ? 'text-success' : 'text-danger'">{{ c.ok ? 'ok' : 'failed' }}</span>
            <span class="text-[10px] text-muted shrink-0 w-14 text-right">{{ formatMs(c.durationMs) }}</span>
          </div>
        }
      </div>
    }
  `,
  host: { class: 'flex flex-col flex-1 min-h-0' },
})
export class AgentActivityTab implements TabComponent {
  protected readonly agents = inject(AgentsState);
  protected readonly actions = inject(UiActions);
  protected readonly formatMs = formatMs;

  readonly tab = input.required<Tab>();
  readonly scope = input.required<string>();

  protected readonly grantsTitle = computed(() => this.agents.grants().map((g) => `${g.agent}: ${g.commandId}`).join('\n'));

  protected decision(call: AgentActivityEntry): { label: string; color: string } {
    return call.decision ? DECISION_LABEL[call.decision] : { label: 'invalid call', color: 'text-muted' };
  }

  protected time(at: string): string {
    return new Date(at).toLocaleTimeString([], { hour12: false });
  }
}
