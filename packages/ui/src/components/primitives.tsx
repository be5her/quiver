import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-fg hover:bg-elevated border-edge',
  ghost: 'bg-transparent text-fg hover:bg-elevated border-transparent',
  danger: 'bg-transparent text-danger hover:bg-danger/10 border-transparent',
};

const sizeClass: Record<Size, string> = {
  sm: 'h-7 px-2 text-xs gap-1',
  md: 'h-8 px-3 text-sm gap-1.5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-md border font-medium transition-colors select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 disabled:pointer-events-none',
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: Size;
}

export function IconButton({ label, size = 'md', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-elevated transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'size-6' : 'size-7',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-edge bg-surface px-2.5 text-sm text-fg placeholder:text-muted/70',
        'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50',
        className,
      )}
      spellCheck={false}
      autoComplete="off"
      {...rest}
    />
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-md border border-edge bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted/70 font-mono',
        'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50',
        className,
      )}
      spellCheck={false}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8 rounded-md border border-edge bg-surface px-2 text-sm text-fg',
        'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Checkbox({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn('size-3.5 accent-accent cursor-pointer', className)} {...rest} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('block text-xs font-medium text-muted mb-1', className)}>{children}</label>;
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: SegmentedOption<NoInfer<T>>[];
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-0.5 border-b border-edge', className)} role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'px-3 h-8 text-xs font-medium border-b-2 -mb-px transition-colors',
            opt.value === value ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium bg-elevated text-muted', className)}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded border border-edge bg-elevated px-1.5 text-[10px] font-mono text-muted leading-4">
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} />;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-center h-full">
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint && <p className="text-xs text-muted max-w-xs">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function SectionHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 h-7 text-[11px] font-semibold uppercase tracking-wide text-muted">
      <span>{title}</span>
      <div className="flex items-center gap-0.5">{actions}</div>
    </div>
  );
}
