import { create } from 'zustand';

export interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** Multi-line text area instead of a single input. */
  multiline?: boolean;
  /** A select shown under the text, whose value comes back with it (see promptWithChoiceDialog). */
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

type PendingDialog =
  | { kind: 'prompt'; options: PromptOptions; resolve(value: string | null, choice?: string): void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve(value: boolean): void };

interface DialogState {
  pending: PendingDialog | null;
  open(dialog: PendingDialog): void;
  close(): void;
}

export const useDialogStore = create<DialogState>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}));

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: 'prompt',
      options,
      resolve: (value) => {
        useDialogStore.getState().close();
        resolve(value);
      },
    });
  });
}

/** A prompt with a select next to the text; resolves with both, or null when cancelled. */
export function promptWithChoiceDialog(options: PromptOptions & { choice: PromptChoice }): Promise<PromptResult | null> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: 'prompt',
      options,
      resolve: (value, choice) => {
        useDialogStore.getState().close();
        resolve(value === null ? null : { value, choice: choice ?? options.choice.defaultValue });
      },
    });
  });
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.getState().open({
      kind: 'confirm',
      options,
      resolve: (value) => {
        useDialogStore.getState().close();
        resolve(value);
      },
    });
  });
}
