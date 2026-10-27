import { Component, computed, inject, input, output, signal } from '@angular/core';
import {
  AGENT_RULE_ACTIONS,
  RULE_MATCH_GRAMMAR,
  isValidRuleMatch,
  parseRuleMatch,
  ruleMatchFor,
  ruleMatchesCommand,
  type AgentPermissionRule,
  type AgentRuleAction,
  type CommandActionsInfo,
} from '@quiver/core';
import { AppState, Button, IconButton, Icon, Input, Select, invokeResource } from '@quiver/ui';
import { Trash2 } from 'lucide';
import { AgentsState } from './agents-state';

let lists = 0;

/** A change to one rule, as the editor hands it up: `action: null` removes it. */
export interface AgentRuleChange {
  match: string;
  agent?: string;
  action: AgentRuleAction | null;
}

/**
 * A table of agent rules: a command id or a glob, optionally one action of the command (`db.query.run#ddl`) and one
 * agent, and allow, ask or deny. Every change is handed up at once as one rule set or removed (`action: null`), so the
 * host applies it to the rules it holds rather than to a list this view drew.
 */
@Component({
  selector: 'q-agent-rules-editor',
  imports: [Button, Icon, IconButton, Input, Select],
  template: `
    <div class="flex flex-col gap-1" [attr.data-testid]="testId()">
      @if (rules().length) {
        <div class="flex items-center gap-2 text-[11px] text-muted px-0.5">
          <span class="flex-1">Tool</span>
          <span class="w-28 shrink-0 px-1">Action</span>
          <span class="w-32 shrink-0 px-1">Agent</span>
          <span class="w-28 shrink-0">Decision</span>
          <span class="w-7 shrink-0"></span>
        </div>
      }
      @for (rule of rules(); track key(rule)) {
        <div
          class="flex items-center gap-2"
          data-testid="agent-rule"
          [attr.data-match]="rule.match"
          [attr.data-action]="rule.action"
          [attr.data-agent]="rule.agent ?? ''"
          [attr.aria-label]="describe(rule)"
        >
          <code class="flex-1 min-w-0 text-xs font-mono bg-surface border border-edge rounded-md px-2 py-1.5 truncate" [title]="matchCount(rule.match) + ' tools'">{{ commandOf(rule) }}</code>
          <span class="w-28 shrink-0 px-1 text-xs font-mono truncate" data-testid="agent-rule-row-tool-action" [class.text-muted]="!actionOf(rule)" [title]="actionTitle(rule)">{{ actionOf(rule) ?? 'any' }}</span>
          <span class="w-32 shrink-0 px-1 text-xs truncate" data-testid="agent-rule-row-agent" [class.text-muted]="!rule.agent" [title]="rule.agent ?? 'Every agent'">{{ rule.agent ?? 'any agent' }}</span>
          <select qSelect class="w-28 shrink-0" data-testid="agent-rule-row-action" [attr.aria-label]="'Decision for ' + describe(rule)" (change)="setAction(rule, $any($event.target).value)">
            @for (a of actions; track a) {
              <option [value]="a" [selected]="a === rule.action">{{ a }}</option>
            }
          </select>
          <button qIconButton size="sm" [label]="'Remove the rule ' + describe(rule)" (click)="remove(rule)"><svg [qIcon]="icons.Trash2" class="size-3.5"></svg></button>
        </div>
      } @empty {
        <p class="text-xs text-muted">{{ emptyText() }}</p>
      }
      <div class="flex items-center gap-2 mt-1">
        <input
          qInput
          class="flex-1 min-w-0 font-mono"
          [attr.list]="listId"
          placeholder="git.*, db.query.run or *"
          aria-label="Tool"
          data-testid="agent-rule-match"
          [value]="match()"
          (input)="match.set($any($event.target).value)"
          (keydown.enter)="add()"
        />
        @if (declared(); as info) {
          <select qSelect class="w-28 shrink-0" aria-label="Action of the tool" data-testid="agent-rule-tool-action" (change)="toolAction.set($any($event.target).value)">
            <option value="" [selected]="!toolAction()">any action</option>
            @for (a of info.actions; track a) {
              <option [value]="a" [selected]="a === toolAction()" [title]="info.describe[a] ?? ''">{{ a }}</option>
            }
          </select>
        } @else {
          <div class="w-28 shrink-0">
            <input
              qInput
              class="font-mono"
              aria-label="Action of the tool"
              data-testid="agent-rule-tool-action"
              [placeholder]="exactId() ? 'any action' : 'any'"
              [disabled]="!exactId()"
              [value]="toolAction()"
              (input)="toolAction.set($any($event.target).value)"
              (keydown.enter)="add()"
            />
          </div>
        }
        <div class="w-32 shrink-0">
          <input
            qInput
            [attr.list]="agentListId"
            placeholder="any agent"
            aria-label="Agent"
            data-testid="agent-rule-agent"
            [value]="agent()"
            (input)="agent.set($any($event.target).value)"
            (keydown.enter)="add()"
          />
        </div>
        <select qSelect class="w-28 shrink-0" aria-label="Decision" data-testid="agent-rule-action" (change)="action.set($any($event.target).value)">
          @for (a of actions; track a) {
            <option [value]="a" [selected]="a === action()">{{ a }}</option>
          }
        </select>
        <button qButton size="sm" variant="secondary" class="shrink-0 whitespace-nowrap" data-testid="agent-rule-add" [disabled]="!valid()" (click)="add()">Add rule</button>
      </div>
      <datalist [id]="listId">
        @for (option of options(); track option) {
          <option [value]="option"></option>
        }
      </datalist>
      <datalist [id]="agentListId">
        @for (name of agentNames(); track name) {
          <option [value]="name"></option>
        }
      </datalist>
      @if (match().trim()) {
        <p class="text-[11px]" data-testid="agent-rule-hint" [class]="valid() ? 'text-muted' : 'text-danger'">{{ hint() }}</p>
      }
    </div>
  `,
})
export class AgentRulesEditor {
  private readonly app = inject(AppState);
  private readonly agents = inject(AgentsState);

  readonly rules = input.required<AgentPermissionRule[]>();
  readonly testId = input('agent-rules');
  readonly emptyText = input('No rules.');
  readonly changed = output<AgentRuleChange>();

  protected readonly icons = { Trash2 };
  protected readonly actions = AGENT_RULE_ACTIONS;
  protected readonly listId = `agent-rule-options-${++lists}`;
  protected readonly agentListId = `agent-rule-agents-${lists}`;
  protected readonly match = signal('');
  /** The action of the tool the new rule names, empty for every action. */
  protected readonly toolAction = signal('');
  protected readonly agent = signal('');
  protected readonly action = signal<AgentRuleAction>('ask');

  /** The commands that declare actions, from the registry. */
  private readonly declaredActions = invokeResource<CommandActionsInfo[]>('mcp.permissions.actions', () => ({}), { workspaceId: null });
  /** The tools agents see: every command that is not plumbing. */
  private readonly tools = computed(() => this.app.commands().filter((c) => !c.hidden));
  /** `*`, a glob per module and every tool id, for the match field to suggest. */
  protected readonly options = computed(() => {
    const ids = this.tools().map((c) => c.id);
    const globs = [...new Set(ids.map((id) => `${id.split('.')[0]}.*`))].sort();
    return ['*', ...globs, ...ids.sort()];
  });
  /** The agents seen in the activity feed, for the agent field to suggest. */
  protected readonly agentNames = computed(() => [...new Set(this.agents.calls().map((c) => c.agent.name))].filter((n) => n && n !== 'unknown').sort());

  /** The match field as typed: the command part, and an action typed after `#` there. */
  private readonly typed = computed(() => parseRuleMatch(this.match().trim()));
  /** The match field names one command (not a glob or `*`), so an action may follow it. */
  protected readonly exactId = computed(() => {
    const { command } = this.typed();
    return command !== '' && command !== '*' && !command.endsWith('.*');
  });
  /** The actions of the command the match field names, when it declares some. */
  protected readonly declared = computed(() => (this.exactId() ? (this.declaredActions.value() ?? []).find((c) => c.commandId === this.typed().command) : undefined));
  /** The match the new rule gets: the field, plus the picked action. An action typed after `#` in the field wins. */
  private readonly fullMatch = computed(() => {
    const { command, action } = this.typed();
    return action !== undefined ? this.match().trim() : ruleMatchFor(command, this.exactId() ? this.toolAction().trim() : '');
  });
  protected readonly valid = computed(() => isValidRuleMatch(this.fullMatch()) && this.knownAction());
  /** False for an action the command does not declare. */
  private readonly knownAction = computed(() => {
    const { action } = parseRuleMatch(this.fullMatch());
    const info = this.declared();
    return action === undefined || !info || info.actions.includes(action);
  });
  protected readonly hint = computed(() => {
    const match = this.fullMatch();
    if (!isValidRuleMatch(match)) return `Use ${RULE_MATCH_GRAMMAR}.`;
    if (!this.knownAction()) return `${this.typed().command} has no action "${parseRuleMatch(match).action}"; its actions are ${this.declared()!.actions.join(', ')}.`;
    const count = this.matchCount(match);
    const what = count ? `Matches ${count} tool${count === 1 ? '' : 's'}` : 'Matches no tool yet';
    const action = parseRuleMatch(match).action;
    return `${what}${action ? `, the calls that ${action}` : ''}${this.agent().trim() ? `, for ${this.agent().trim()} only` : ''}.`;
  });

  protected key(rule: AgentPermissionRule): string {
    return `${rule.match}\u0000${rule.agent ?? ''}`;
  }

  protected commandOf(rule: AgentPermissionRule): string {
    return parseRuleMatch(rule.match).command;
  }

  protected actionOf(rule: AgentPermissionRule): string | undefined {
    return parseRuleMatch(rule.match).action;
  }

  protected actionTitle(rule: AgentPermissionRule): string {
    const { command, action } = parseRuleMatch(rule.match);
    if (!action) return 'Every call of the tool';
    return (this.declaredActions.value() ?? []).find((c) => c.commandId === command)?.describe[action] ?? action;
  }

  /** A rule as one line: `db.query.run · ddl · claude-code · deny`. */
  protected describe(rule: AgentPermissionRule): string {
    return [this.commandOf(rule), this.actionOf(rule) ?? 'any action', rule.agent ?? 'any agent', rule.action].join(' · ');
  }

  protected matchCount(match: string): number {
    return this.tools().filter((c) => ruleMatchesCommand(match, c.id)).length;
  }

  protected add(): void {
    const match = this.fullMatch();
    if (!this.valid()) return;
    const agent = this.agent().trim();
    this.changed.emit({ match, action: this.action(), ...(agent ? { agent } : {}) });
    this.match.set('');
    this.toolAction.set('');
  }

  protected setAction(rule: AgentPermissionRule, action: AgentRuleAction): void {
    this.changed.emit({ match: rule.match, action, ...(rule.agent ? { agent: rule.agent } : {}) });
  }

  protected remove(rule: AgentPermissionRule): void {
    this.changed.emit({ match: rule.match, action: null, ...(rule.agent ? { agent: rule.agent } : {}) });
  }
}
