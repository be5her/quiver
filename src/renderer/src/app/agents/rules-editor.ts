import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AGENT_RULE_ACTIONS, isValidRuleMatch, ruleSpecificity, type AgentPermissionRule, type AgentRuleAction } from '@quiver/core';
import { AppState, Button, IconButton, Icon, Input, Select } from '@quiver/ui';
import { Trash2 } from 'lucide';

let lists = 0;

/**
 * A table of agent rules: a command id or a glob, and allow, ask or deny. Every change is handed up at once as one rule
 * set or removed (`action: null`), so the host applies it to the rules it holds rather than to a list this view drew.
 */
@Component({
  selector: 'q-agent-rules-editor',
  imports: [Button, Icon, IconButton, Input, Select],
  template: `
    <div class="flex flex-col gap-1" [attr.data-testid]="testId()">
      @for (rule of rules(); track rule.match) {
        <div class="flex items-center gap-2" data-testid="agent-rule" [attr.data-match]="rule.match" [attr.data-action]="rule.action">
          <code class="flex-1 text-xs font-mono bg-surface border border-edge rounded-md px-2 py-1.5 truncate" [title]="matchCount(rule.match) + ' tools'">{{ rule.match }}</code>
          <select qSelect class="w-28" data-testid="agent-rule-row-action" [attr.aria-label]="'Action for ' + rule.match" (change)="setAction(rule, $any($event.target).value)">
            @for (a of actions; track a) {
              <option [value]="a" [selected]="a === rule.action">{{ a }}</option>
            }
          </select>
          <button qIconButton size="sm" [label]="'Remove the rule for ' + rule.match" (click)="remove(rule)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
        </div>
      } @empty {
        <p class="text-xs text-muted">{{ emptyText() }}</p>
      }
      <div class="flex items-center gap-2 mt-1">
        <input
          qInput
          class="flex-1 font-mono"
          [attr.list]="listId"
          placeholder="git.*, db.query.run or *"
          data-testid="agent-rule-match"
          [value]="match()"
          (input)="match.set($any($event.target).value)"
          (keydown.enter)="add()"
        />
        <select qSelect class="w-28" aria-label="Action" data-testid="agent-rule-action" (change)="action.set($any($event.target).value)">
          @for (a of actions; track a) {
            <option [value]="a" [selected]="a === action()">{{ a }}</option>
          }
        </select>
        <button qButton size="sm" variant="secondary" data-testid="agent-rule-add" [disabled]="!valid()" (click)="add()">Add rule</button>
      </div>
      <datalist [id]="listId">
        @for (option of options(); track option) {
          <option [value]="option"></option>
        }
      </datalist>
      @if (match().trim()) {
        <p class="text-[11px]" [class]="valid() ? 'text-muted' : 'text-danger'">{{ hint() }}</p>
      }
    </div>
  `,
})
export class AgentRulesEditor {
  private readonly app = inject(AppState);

  readonly rules = input.required<AgentPermissionRule[]>();
  readonly testId = input('agent-rules');
  readonly emptyText = input('No rules.');
  readonly changed = output<{ match: string; action: AgentRuleAction | null }>();

  protected readonly icons = { Trash2 };
  protected readonly actions = AGENT_RULE_ACTIONS;
  protected readonly listId = `agent-rule-options-${++lists}`;
  protected readonly match = signal('');
  protected readonly action = signal<AgentRuleAction>('ask');

  /** The tools agents see: every command that is not plumbing. */
  private readonly tools = computed(() => this.app.commands().filter((c) => !c.hidden));
  /** `*`, a glob per module and every tool id, for the match field to suggest. */
  protected readonly options = computed(() => {
    const ids = this.tools().map((c) => c.id);
    const globs = [...new Set(ids.map((id) => `${id.split('.')[0]}.*`))].sort();
    return ['*', ...globs, ...ids.sort()];
  });
  protected readonly valid = computed(() => isValidRuleMatch(this.match().trim()));
  protected readonly hint = computed(() => {
    const match = this.match().trim();
    if (!this.valid()) return 'A command id, a glob ending in .* (git.*, git.branch.*) or * for every tool.';
    const count = this.matchCount(match);
    return count ? `Matches ${count} tool${count === 1 ? '' : 's'}.` : 'Matches no tool yet.';
  });

  protected matchCount(match: string): number {
    return this.tools().filter((c) => ruleSpecificity(match, c.id) >= 0).length;
  }

  protected add(): void {
    const match = this.match().trim();
    if (!isValidRuleMatch(match)) return;
    this.changed.emit({ match, action: this.action() });
    this.match.set('');
  }

  protected setAction(rule: AgentPermissionRule, action: AgentRuleAction): void {
    this.changed.emit({ match: rule.match, action });
  }

  protected remove(rule: AgentPermissionRule): void {
    this.changed.emit({ match: rule.match, action: null });
  }
}
