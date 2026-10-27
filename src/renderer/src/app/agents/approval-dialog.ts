import { Component, computed, effect, inject, signal } from '@angular/core';
import { Autofocus, Button, Icon } from '@quiver/ui';
import { ShieldAlert } from 'lucide';
import { AgentsState } from './agents-state';

/** How long a newly shown approval ignores clicks. */
const ARM_DELAY_MS = 400;

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
          [attr.data-action]="pending.action ?? ''"
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
                @if (pending.action) {
                  · <code class="font-mono font-semibold text-fg" data-testid="agent-approval-action" [title]="'What this call does: rules can name it as ' + pending.commandId + '#' + pending.action">{{ pending.action }}</code>
                }
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
          <!-- Right-aligned, so the buttons that wrap to a second line (Always allow for an action and for the tool) stay under the others. -->
          <div class="flex flex-wrap items-center justify-end gap-2">
            <button qButton variant="ghost" class="mr-auto" data-testid="agent-approval-deny" [disabled]="busy()" (click)="agents.respond(pending, 'deny')">Deny</button>
            @if (pending.action) {
              <div class="flex items-center gap-1" role="group" aria-label="Always allow">
                <button
                  qButton
                  data-testid="agent-approval-always-action"
                  [disabled]="busy()"
                  [title]="'Adds a rule that allows ' + pending.commandId + '#' + pending.action + ' for every agent, in Settings > MCP; its other actions still follow their rules'"
                  (click)="agents.respond(pending, 'always', 'action')"
                >
                  Always allow {{ pending.action }}
                </button>
                <button qButton data-testid="agent-approval-always" [disabled]="busy()" title="Adds a rule that allows this tool, every action of it, for every agent, in Settings > MCP" (click)="agents.respond(pending, 'always', 'tool')">
                  Always allow tool
                </button>
              </div>
            } @else {
              <button qButton data-testid="agent-approval-always" [disabled]="busy()" title="Adds a rule that allows this tool for every agent, in Settings > MCP" (click)="agents.respond(pending, 'always')">Always allow</button>
            }
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
  protected readonly waiting = computed(() => Math.max(0, this.agents.unanswered().length - 1));
  /** The id alone, so a reload of the list that keeps the same approval on screen changes nothing below. */
  private readonly currentId = computed(() => this.agents.current()?.id ?? null);
  /** The approval whose buttons work: a new one only after a moment, so a click meant for the last one cannot answer it. */
  private readonly armed = signal<string | null>(null);
  protected readonly busy = computed(() => {
    const id = this.currentId();
    return this.agents.answering() === id || this.armed() !== id;
  });
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
    effect((onCleanup) => {
      const id = this.currentId();
      this.armed.set(null);
      if (!id) return;
      const timer = setTimeout(() => this.armed.set(id), ARM_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected json(value: unknown): string {
    return JSON.stringify(value, null, 2) ?? '';
  }
}
