import { Service, signal, untracked } from '@angular/core';
import { lookupVariable, type DefineVariable, type SaveVariable, type VariableContext, type VariableInfo, type VariableScope } from './variables';

export interface VariableCard {
  name: string;
  info: VariableInfo | undefined;
  environment: VariableScope['environment'];
  environments: NonNullable<VariableScope['environments']>;
  anchor: { left: number; top: number; bottom: number };
  save?: SaveVariable;
  define?: DefineVariable;
}

/** The value card shown over a hovered `{{variable}}`. The shell's hover card host draws it. */
@Service()
export class VariableHover {
  private readonly cardState = signal<VariableCard | null>(null);
  private readonly revealedState = signal(false);
  private readonly editingState = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly card = this.cardState.asReadonly();
  readonly revealed = this.revealedState.asReadonly();
  /** Set while the value is being edited: the card then stays put until saved or cancelled. */
  readonly editing = this.editingState.asReadonly();

  /** Show the card for the variable under the pointer. `rect` is the placeholder's box on screen. */
  showFor(scope: VariableContext, name: string, rect: DOMRect): void {
    this.show({
      name,
      info: lookupVariable(scope, name),
      environment: scope.environment,
      environments: scope.environments ?? [],
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
      save: scope.save,
      define: scope.define,
    });
  }

  show(card: VariableCard): void {
    if (untracked(this.editingState)) return;
    this.clearTimer();
    const current = untracked(this.cardState);
    const same = current?.name === card.name && current.anchor.left === card.anchor.left && current.anchor.top === card.anchor.top;
    this.cardState.set(card);
    if (!same) this.revealedState.set(false);
  }

  /** A short grace period lets the pointer travel from the variable into the card. */
  scheduleHide(): void {
    if (!untracked(this.cardState) || this.timer || untracked(this.editingState)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.cardState.set(null);
      this.revealedState.set(false);
    }, 180);
  }

  cancelHide(): void {
    this.clearTimer();
  }

  hide(): void {
    this.clearTimer();
    this.cardState.set(null);
    this.revealedState.set(false);
    this.editingState.set(false);
  }

  toggleReveal(): void {
    this.revealedState.update((revealed) => !revealed);
  }

  setEditing(editing: boolean): void {
    this.clearTimer();
    this.editingState.set(editing);
  }

  /** Reflect a saved value in the open card until the next refresh of the variables. */
  setValue(value: string): void {
    const card = untracked(this.cardState);
    if (card?.info) this.cardState.set({ ...card, info: { ...card.info, value } });
  }

  /** Re-read the open card's variable from fresh variables, after defining it. */
  refresh(scope: VariableScope): void {
    const card = untracked(this.cardState);
    if (card) this.cardState.set({ ...card, info: lookupVariable(scope, card.name), environment: scope.environment, environments: scope.environments ?? card.environments });
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
