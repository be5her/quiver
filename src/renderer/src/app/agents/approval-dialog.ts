import { Component, computed, effect, inject, signal } from '@angular/core';
import { Autofocus, Button, Icon } from '@quiver/ui';
import { ShieldAlert } from 'lucide';
import { AgentsState } from './agents-state';

/**
 * Asks the user about an agent's call the permissions say to ask about. One at a time, the oldest first;
 * the others wait their turn. Mount once in the shell.
 *
 * The dialog opens over whatever the user is doing, so it takes the focus itself rather than giving it to a button:
 * an Enter or a Space typed for the editor underneath must not allow a call. Each approval is drawn afresh (tracked
 * by id), so the focus also leaves the button that answered the previous one.
 */
@Component({
  selector: 'q-agent-approval-dialog',
  imports: [Autofocus, Button, Icon],
  template: `
    @for (pending of shown(); track pending.id) {
      <div class="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 pt-[14vh]">
        <div
          class="w-[520px] max-w-[92vw] rounded-lg border border-warning/50 bg-canvas shadow-xl p-4 flex flex-col gap-3 outline-none"
          tabindex="-1"
          qAutofocus
          role="alertdialog"
          aria-labelledby="agent-approval-title"
          data-testid="agent-approval"
          [attr.data-approval]="pending.id"
          [attr.data-tool]="pending.commandId"
          (keydown.escape)="agents.respond(pending, 'deny')"
        >
          <div class="flex items-start gap-2">
            <svg [qIcon]="icons.ShieldAlert" class="size-4 text-warning shrink-0 mt-0.5"></svg>
            <div class="min-w-0">
              <h2 id="agent-approval-title" class="text-sm font-semibold">
                <span data-testid="agent-approval-agent">{{ pending.agent.name }}</span> wants to run {{ pending.title }}
              </h2>
              <p class="text-xs text-muted mt-0.5">
                <code class="font-mono" data-testid="agent-approval-tool">{{ pending.commandId }}</code>
                @if (pending.mutating) {
                  · can change data
                }
                · {{ pending.workspace ? 'in ' + pending.workspace.name : 'no workspace' }}
                @if (pending.agent.version) {
                  · {{ pending.agent.name }} {{ pending.agent.version }}
                }
              </p>
            </div>
          </div>
          @if (pending.workspace) {
            <p class="text-[11px] text-muted font-mono truncate -mt-1" [title]="pending.workspace.path">{{ pending.workspace.path }}</p>
          }
          <div>
            <p class="text-[11px] text-muted mb-1">Arguments (credentials masked)</p>
            <pre class="text-xs font-mono bg-surface border border-edge rounded-md px-2 py-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all" data-testid="agent-approval-input">{{ json(pending.input) }}</pre>
          </div>
          <div class="flex items-center gap-2 text-[11px] text-muted">
            <span data-testid="agent-approval-countdown">Refused in {{ secondsLeft() }} s without an answer.</span>
            @if (waiting() > 0) {
              <span class="text-warning" data-testid="agent-approval-queue">{{ waiting() }} more waiting</span>
            }
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button qButton variant="ghost" data-testid="agent-approval-deny" [disabled]="busy()" (click)="agents.respond(pending, 'deny')">Deny</button>
            <div class="flex-1"></div>
            <button qButton data-testid="agent-approval-always" [disabled]="busy()" title="Adds a rule that allows this tool for every agent, in Settings > MCP" (click)="agents.respond(pending, 'always')">Always allow</button>
            <button qButton data-testid="agent-approval-session" [disabled]="busy()" [title]="'Allows ' + pending.commandId + ' for ' + pending.agent.name + ' until Quiver restarts'" (click)="agents.respond(pending, 'session')">
              Allow until restart
            </button>
            <button qButton variant="primary" data-testid="agent-approval-once" [disabled]="busy()" (click)="agents.respond(pending, 'once')">Allow once</button>
          </div>
        </div>
      </div>
    }
  `,
  host: { class: 'contents' },
})
export class ApprovalDialog {
  protected readonly agents = inject(AgentsState);
  protected readonly icons = { ShieldAlert };
  private readonly now = signal(Date.now());

  /** The approval on screen, as a list of at most one, so a new one is drawn afresh. */
  protected readonly shown = computed(() => {
    const current = this.agents.current();
    return current ? [current] : [];
  });
  protected readonly waiting = computed(() => Math.max(0, this.agents.pending().length - 1));
  protected readonly busy = computed(() => this.agents.answering() === this.agents.current()?.id);
  protected readonly secondsLeft = computed(() => {
    const pending = this.agents.current();
    return pending ? Math.max(0, Math.ceil((Date.parse(pending.expiresAt) - this.now()) / 1000)) : 0;
  });

  constructor() {
    // A countdown only while something waits.
    effect((onCleanup) => {
      if (!this.agents.current()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected json(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? '';
  }
}
