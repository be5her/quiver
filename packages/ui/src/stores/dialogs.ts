import { create } from 'zustand';

export interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** Multi-line text area instead of a single input. */
  multiline?: boolean;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

type PendingDialog =
  | { kind: 'prompt'; options: PromptOptions; resolve(value: string | null): void }
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
