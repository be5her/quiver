import { Component, ElementRef, afterRenderEffect, booleanAttribute, computed, inject, input, model, output, viewChild } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { findVariableSpans } from '@quiver/core';
import { Autofocus } from '../controls/autofocus';
import { Input } from '../controls/native-controls';
import { VariableHover } from './variable-hover';
import { injectVariables, lookupVariable } from './variables';

interface Piece {
  text: string;
  /** Set for a `{{variable}}`, with whether the scope knows it. */
  name?: string;
  known?: boolean;
}

/**
 * A text input that marks `{{variables}}` (unknown ones in red) and shows their value on hover.
 * A layer of translucent chips sits over the text, lined up with it and scrolled with it.
 * Outside a `[qVariables]` scope it is a plain input. Bind it with `[formField]` or `[(value)]`.
 */
@Component({
  selector: 'q-variable-input',
  imports: [Autofocus, Input],
  templateUrl: './variable-input.html',
  host: { '[class]': 'scope() ? "relative w-full min-w-0" : "contents"' },
})
export class VariableInput implements FormValueControl<string> {
  private readonly hover = inject(VariableHover);
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly layer = viewChild<ElementRef<HTMLDivElement>>('layer');

  readonly value = model('');
  readonly placeholder = input('');
  readonly readonly = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly type = input('text');
  /** Classes for the input itself (the host only wraps it). */
  readonly inputClass = input('');
  readonly autofocus = input(false, { transform: booleanAttribute });
  readonly testId = input<string>();
  readonly touch = output<void>();

  protected readonly scope = injectVariables();
  protected readonly pieces = computed<Piece[]>(() => {
    const scope = this.scope();
    if (!scope) return [];
    const text = this.value();
    const pieces: Piece[] = [];
    let at = 0;
    for (const span of findVariableSpans(text)) {
      if (span.from > at) pieces.push({ text: text.slice(at, span.from) });
      pieces.push({ text: text.slice(span.from, span.to), name: span.name, known: Boolean(lookupVariable(scope, span.name)) });
      at = span.to;
    }
    if (at < text.length) pieces.push({ text: text.slice(at) });
    return pieces;
  });
  /** The variable names in the text, for tests and tooling; absent when there are none. */
  protected readonly names = computed(() => {
    const names = this.pieces().flatMap((p) => (p.name ? [p.name] : []));
    return names.length ? names.join(',') : null;
  });

  constructor() {
    afterRenderEffect({
      write: () => {
        this.pieces();
        this.sync();
      },
    });
  }

  focus(options?: FocusOptions): void {
    this.field().nativeElement.focus(options);
  }

  protected typed(): void {
    this.value.set(this.field().nativeElement.value);
  }

  /** Line the chip layer up with the input's font, padding and scroll position. */
  protected sync(): void {
    const input = this.field().nativeElement;
    const layer = this.layer()?.nativeElement;
    if (!layer) return;
    const style = getComputedStyle(input);
    layer.style.font = style.font;
    layer.style.letterSpacing = style.letterSpacing;
    layer.style.paddingLeft = `${parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)}px`;
    layer.style.paddingRight = `${parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth)}px`;
    layer.scrollLeft = input.scrollLeft;
  }

  protected hoverAt(event: MouseEvent): void {
    const scope = this.scope();
    if (!scope) return;
    const chips = [...(this.layer()?.nativeElement.querySelectorAll<HTMLElement>('[data-var-name]') ?? [])];
    const hit = chips.find((el) => {
      const r = el.getBoundingClientRect();
      return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    });
    if (hit) this.hover.showFor(scope, hit.dataset['varName']!, hit.getBoundingClientRect());
    else this.hover.scheduleHide();
  }

  protected leave(): void {
    if (this.scope()) this.hover.scheduleHide();
  }
}
