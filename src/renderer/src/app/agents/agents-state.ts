import { DestroyRef, Service, computed, inject, signal, untracked } from '@angular/core';
import type { AgentActivityEntry, ApprovalChoice, ApprovalGrant, PendingApproval } from '@quiver/core';
import { AppState, HostBridge, TabsState, Toasts, invokeResource } from '@quiver/ui';

interface ActivityView {
  calls: AgentActivityEntry[];
  pending: PendingApproval[];
  grants: ApprovalGrant[];
  paused: boolean;
}

/** What agents do on Quiver's MCP server, as the status bar, the approval dialog and the Agent activity tab show it. */
@Service()
export class AgentsState {
  private readonly app = inject(AppState);
  private readonly host = inject(HostBridge);
  private readonly tabs = inject(TabsState);
  private readonly toasts = inject(Toasts);

  private readonly activity = invokeResource<ActivityView>('mcp.activity.list', () => ({}), {
    workspaceId: null,
    refreshOnEvents: ['mcp.activity', 'mcp.approval.requested', 'config.changed'],
  });
  /** Ticks every five seconds, so "calls in the last minute" counts down without new calls. */
  private readonly now = signal(Date.now());

  readonly calls = computed(() => this.activity.value()?.calls ?? []);
  readonly pending = computed(() => this.activity.value()?.pending ?? []);
  readonly grants = computed(() => this.activity.value()?.grants ?? []);
  readonly paused = computed(() => this.app.config()?.mcp.paused ?? false);
  readonly lastMinute = computed(() => {
    const since = this.now() - 60_000;
    return this.calls().filter((c) => Date.parse(c.at) >= since).length;
  });
  /** The approval the dialog shows: the oldest one waiting. */
  readonly current = computed(() => this.pending()[0] ?? null);
  /** Set while an answer is on its way, so a double click cannot answer the next approval. */
  readonly answering = signal<string | null>(null);

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  openTab(): void {
    this.tabs.openTab(untracked(this.app.scope), { type: 'shell.agents', title: 'Agent activity', data: { key: 'agents' } }, { singletonKey: 'shell.agents:agents' });
  }

  async respond(pending: PendingApproval, choice: ApprovalChoice): Promise<void> {
    if (untracked(this.answering) === pending.id) return;
    this.answering.set(pending.id);
    try {
      const { level } = await this.host.invoke<{ level?: 'workspace' | 'global' }>('mcp.approval.respond', { id: pending.id, choice }, null);
      if (choice === 'always') {
        const where = level === 'workspace' && pending.workspace ? ` in ${pending.workspace.name}` : '';
        this.toasts.notify(`${pending.commandId} is now always allowed for agents${where}. Change it in Settings > MCP.`, 'success');
      }
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.answering.set(null);
      this.activity.reload();
    }
  }

  async setPaused(paused: boolean): Promise<void> {
    try {
      await this.host.invoke('mcp.pause', { paused }, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }

  async clearGrants(): Promise<void> {
    try {
      await this.host.invoke('mcp.approval.clearGrants', {}, null);
    } catch (err) {
      this.toasts.error(err);
    }
  }
}

/** How each decision reads in the activity list, and its colour. */
export const DECISION_LABEL: Record<NonNullable<AgentActivityEntry['decision']>, { label: string; color: string }> = {
  allowed: { label: 'allowed', color: 'text-muted' },
  approved: { label: 'approved', color: 'text-success' },
  refused: { label: 'refused', color: 'text-danger' },
  denied: { label: 'denied', color: 'text-danger' },
  'approval-timeout': { label: 'timed out', color: 'text-warning' },
  paused: { label: 'paused', color: 'text-warning' },
  cancelled: { label: 'cancelled', color: 'text-muted' },
};
