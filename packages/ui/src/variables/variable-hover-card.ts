import { Component, ElementRef, afterRenderEffect, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormField, disabled, form } from '@angular/forms/signals';
import { DEFINABLE_VARIABLE_NAME } from '@quiver/core';
import { Check, Copy, Eye, EyeOff, Pencil, Plus, X } from 'lucide';
import { Autofocus } from '../controls/autofocus';
import { Button } from '../controls/button';
import { Checkbox, Select } from '../controls/native-controls';
import { Icon } from '../icon/icon';
import { Toasts } from '../toasts/toasts';
import { VariableHover } from './variable-hover';
import type { VariableTarget } from './variables';

const MASK = '••••••••';

/** What the card's fields edit: the value, and for a missing variable where and how to define it. */
interface CardEdit {
  draft: string;
  /** 'global' or an environment id. */
  target: string;
  secret: boolean;
}

/** Renders the variable hover card. Mount once in the shell. */
@Component({
  selector: 'q-variable-hover-card',
  imports: [Autofocus, Button, Checkbox, FormField, Icon, Select],
  templateUrl: './variable-hover-card.html',
  host: { class: 'contents' },
})
export class VariableHoverCard {
  private readonly hover = inject(VariableHover);
  private readonly toasts = inject(Toasts);
  private readonly panel = viewChild<ElementRef<HTMLDivElement>>('panel');

  protected readonly icons = { Check, Copy, Eye, EyeOff, Pencil, Plus, X };
  protected readonly mask = MASK;
  protected readonly card = this.hover.card;
  protected readonly revealed = this.hover.revealed;
  protected readonly editing = this.hover.editing;
  protected readonly saving = signal(false);
  protected readonly edit = signal<CardEdit>({ draft: '', target: 'global', secret: false });
  // Global variables are plain config, so they cannot be secret.
  protected readonly editForm = form(this.edit, (p) => disabled(p.secret, ({ valueOf }) => valueOf(p.target) === 'global'));

  protected readonly info = computed(() => this.card()?.info);
  /** The placeholder as written, e.g. {{baseUrl}}. */
  protected readonly braced = computed(() => '{{' + (this.card()?.name ?? '') + '}}');
  protected readonly source = computed(() => {
    const card = this.card();
    const info = card?.info;
    if (!info) return 'Not defined';
    return info.source === 'environment' ? `Environment · ${card.environment?.name ?? ''}` : info.source === 'global' ? 'Global' : 'Built-in';
  });
  protected readonly hidden = computed(() => Boolean(this.info()?.secret) && !this.revealed());
  protected readonly editable = computed(() => {
    const card = this.card();
    return Boolean(card?.save && card.info && card.info.source !== 'dynamic');
  });
  protected readonly definable = computed(() => {
    const card = this.card();
    return Boolean(card?.define && !card.info && DEFINABLE_VARIABLE_NAME.test(card.name));
  });
  protected readonly defining = computed(() => this.editing() && !this.info());
  /** Active environment first, then the others by name. */
  protected readonly targets = computed(() => {
    const card = this.card();
    if (!card) return [];
    const active = card.environment;
    return active ? [active, ...card.environments.filter((e) => e.id !== active.id)] : card.environments;
  });
  protected readonly note = computed(() => this.describe());

  constructor() {
    // Below the variable, or above it when there is no room, and always inside the window.
    afterRenderEffect({
      write: () => {
        const card = this.card();
        this.revealed();
        this.editing();
        this.edit();
        const panel = this.panel()?.nativeElement;
        if (!card || !panel) return;
        const { width, height } = panel.getBoundingClientRect();
        const below = card.anchor.bottom + 6;
        panel.style.top = `${below + height > window.innerHeight - 4 ? Math.max(4, card.anchor.top - height - 6) : below}px`;
        panel.style.left = `${Math.max(4, Math.min(card.anchor.left, window.innerWidth - width - 4))}px`;
        panel.style.visibility = 'visible';
      },
    });

    effect((onCleanup) => {
      if (!this.card()) return;
      const inside = (e: Event) => this.panel()?.nativeElement.contains(e.target as Node) ?? false;
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        // Escape backs out of editing first, then closes the card.
        if (untracked(this.editing)) {
          e.stopPropagation();
          this.hover.setEditing(false);
        } else this.hover.hide();
      };
      const onDown = (e: MouseEvent) => !inside(e) && this.hover.hide();
      // Scrolling the value inside the card must not close it; scrolling the page does.
      const onScroll = (e: Event) => !inside(e) && this.hover.hide();
      // Switching windows keeps an edit in progress.
      const onBlur = () => !untracked(this.editing) && this.hover.hide();
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('scroll', onScroll, true);
      window.addEventListener('blur', onBlur);
      onCleanup(() => {
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('blur', onBlur);
      });
    });
  }

  protected cancelHide(): void {
    this.hover.cancelHide();
  }

  protected scheduleHide(): void {
    this.hover.scheduleHide();
  }

  protected toggleReveal(): void {
    this.hover.toggleReveal();
  }

  protected cancelEditing(): void {
    this.hover.setEditing(false);
  }

  protected copyValue(): void {
    const card = this.card();
    if (card?.info?.value == null) return;
    this.toasts.copy(card.info.value, `Copied the value of ${card.name}`);
  }

  protected startEditing(): void {
    if (!this.editable()) return;
    this.edit.update((e) => ({ ...e, draft: this.info()?.value ?? '' }));
    this.hover.setEditing(true);
  }

  protected startDefining(): void {
    if (!this.definable()) return;
    this.edit.set({ draft: '', target: this.card()?.environment?.id ?? 'global', secret: false });
    this.hover.setEditing(true);
  }

  /** Picking the global variables as the target clears the secret flag they cannot have. */
  protected targetPicked(event: Event): void {
    if ((event.target as HTMLSelectElement).value === 'global') this.edit.update((e) => ({ ...e, secret: false }));
  }

  /** Enter saves; Shift+Enter adds a line. */
  protected draftKey(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.commit();
  }

  protected selectAll(event: FocusEvent): void {
    (event.target as HTMLTextAreaElement).select();
  }

  protected async commit(): Promise<void> {
    if (this.defining()) return this.commitDefine();
    const card = this.card();
    if (!card?.save || this.saving()) return;
    const { draft } = this.edit();
    if (draft === card.info?.value) return this.hover.setEditing(false);
    this.saving.set(true);
    try {
      await card.save(card.name, draft);
      this.hover.setValue(draft);
      this.hover.setEditing(false);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  private async commitDefine(): Promise<void> {
    const card = this.card();
    if (!card?.define || this.saving()) return;
    const { draft, target, secret } = this.edit();
    this.saving.set(true);
    try {
      const where: VariableTarget = target === 'global' ? { kind: 'global' } : { kind: 'environment', id: target };
      const next = await card.define(card.name, draft, where, where.kind === 'environment' && secret);
      this.hover.setEditing(false);
      this.hover.refresh(next);
    } catch (err) {
      this.toasts.error(err);
    } finally {
      this.saving.set(false);
    }
  }

  private describe(): string | null {
    const card = this.card();
    if (!card) return null;
    const { info, name, environment, environments } = card;
    const envName = environment?.name;
    const { target, secret } = this.edit();
    if (this.defining()) {
      const targetEnv = environments.find((e) => e.id === target);
      if (!targetEnv) return 'Global variables are used by every workspace and stored in plain config, so they cannot be secret.';
      return targetEnv.id === environment?.id
        ? `Adds ${name} to the active environment${secret ? ', encrypted on this machine' : ''}.`
        : `${targetEnv.name} is not active, so ${name} stays undefined here until you switch to it.`;
    }
    if (this.editing()) {
      return info?.source === 'environment'
        ? `Saves to the ${envName ?? 'active'} environment${info.secret ? ', encrypted on this machine' : ''}. Enter saves, Shift+Enter adds a line.`
        : 'Saves to the global variables, which every workspace uses. Enter saves, Shift+Enter adds a line.';
    }
    if (!info) {
      return envName
        ? `Not in the ${envName} environment or the global variables; it is sent as written.`
        : 'No environment is active and no global variable has this name; it is sent as written.';
    }
    if (info.source === 'dynamic') return `${info.help ?? 'Built-in value'}, new on every send.`;
    if (info.secret) return 'Secret, stored encrypted on this machine.';
    if (info.overridesGlobal) return 'Overrides the global variable of the same name.';
    return null;
  }
}
