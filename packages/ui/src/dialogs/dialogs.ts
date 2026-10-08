import { Service, signal } from '@angular/core';

export interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** Multi-line text area instead of a single input. */
  multiline?: boolean;
  /** A select shown under the text, whose value comes back with it (see `promptWithChoice`). */
  choice?: PromptChoice;
}

export interface PromptChoice {
  label: string;
  options: { value: string; label: string }[];
  defaultValue: string;
  /** A line shown next to the select, recomputed as the text and the choice change. */
  hint?(text: string, choice: string): string | null;
}

export interface PromptResult {
  value: string;
  choice: string;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export type PendingDialog =
  | { kind: 'prompt'; options: PromptOptions; resolve(value: string | null, choice?: string): void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve(value: boolean): void };

/** Prompt and confirm dialogs as promises. The shell's dialog host draws the pending one. */
@Service()
export class Dialogs {
  private readonly current = signal<PendingDialog | null>(null);

  readonly pending = this.current.asReadonly();

  prompt(options: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      this.current.set({
        kind: 'prompt',
        options,
        resolve: (value) => {
          this.current.set(null);
          resolve(value);
        },
      });
    });
  }

  /** A prompt with a select next to the text; resolves with both, or null when cancelled. */
  promptWithChoice(options: PromptOptions & { choice: PromptChoice }): Promise<PromptResult | null> {
    return new Promise((resolve) => {
      this.current.set({
        kind: 'prompt',
        options,
        resolve: (value, choice) => {
          this.current.set(null);
          resolve(value === null ? null : { value, choice: choice ?? options.choice.defaultValue });
        },
      });
    });
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.current.set({
        kind: 'confirm',
        options,
        resolve: (value) => {
          this.current.set(null);
          resolve(value);
        },
      });
    });
  }
}
