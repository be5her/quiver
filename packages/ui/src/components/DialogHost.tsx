import { useEffect, useState } from 'react';
import { useDialogStore } from '../stores/dialogs';
import { Button, Input, Label, TextArea } from './primitives';

/** Renders the pending prompt/confirm dialog. Mount once in the shell. */
export function DialogHost() {
  const pending = useDialogStore((s) => s.pending);
  if (!pending) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]" onMouseDown={() => cancel()}>
      <div
        className="w-[440px] max-w-[90vw] rounded-lg border border-edge bg-canvas shadow-xl p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {pending.kind === 'prompt' ? <PromptBody key={pending.options.title} /> : <ConfirmBody />}
      </div>
    </div>
  );

  function cancel() {
    if (pending?.kind === 'prompt') pending.resolve(null);
    else pending?.resolve(false);
  }
}

function PromptBody() {
  const pending = useDialogStore((s) => s.pending);
  const [value, setValue] = useState('');
  useEffect(() => {
    if (pending?.kind === 'prompt') setValue(pending.options.defaultValue ?? '');
  }, [pending]);
  if (pending?.kind !== 'prompt') return null;
  const { options, resolve } = pending;
  const submit = () => resolve(value);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') resolve(null);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
      }}
    >
      <h2 className="text-sm font-semibold mb-3">{options.title}</h2>
      {options.label && <Label>{options.label}</Label>}
      {options.multiline ? (
        <TextArea autoFocus rows={8} value={value} placeholder={options.placeholder} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <Input autoFocus value={value} placeholder={options.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
      )}
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={() => resolve(null)}>
          Cancel
        </Button>
        <Button variant="primary" type="submit">
          {options.confirmLabel ?? 'OK'}
        </Button>
      </div>
    </form>
  );
}

function ConfirmBody() {
  const pending = useDialogStore((s) => s.pending);
  if (pending?.kind !== 'confirm') return null;
  const { options, resolve } = pending;
  return (
    <div onKeyDown={(e) => e.key === 'Escape' && resolve(false)}>
      <h2 className="text-sm font-semibold mb-1">{options.title}</h2>
      {options.message && <p className="text-sm text-muted">{options.message}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={() => resolve(false)} autoFocus>
          Cancel
        </Button>
        <Button variant={options.danger ? 'danger' : 'primary'} onClick={() => resolve(true)} className={options.danger ? 'border-danger/40' : ''}>
          {options.confirmLabel ?? 'Confirm'}
        </Button>
      </div>
    </div>
  );
}
