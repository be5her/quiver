import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../cn';
import { useAppStore } from '../stores/app';

const icons = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

export function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-8 right-3 z-50 flex flex-col gap-2 w-80">
      {toasts.map((t) => {
        const Icon = icons[t.kind];
        return (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2 rounded-md border bg-canvas shadow-lg px-3 py-2 text-sm',
              t.kind === 'error' ? 'border-danger/50' : t.kind === 'success' ? 'border-success/50' : 'border-edge',
            )}
          >
            <Icon className={cn('size-4 mt-0.5 shrink-0', t.kind === 'error' ? 'text-danger' : t.kind === 'success' ? 'text-success' : 'text-muted')} />
            <span className="flex-1 break-words">{t.message}</span>
            <button type="button" className="text-muted hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
