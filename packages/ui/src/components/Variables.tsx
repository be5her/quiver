import { findVariableSpans } from '@quiver/core';
import { Check, Copy, Eye, EyeOff, Pencil, X } from 'lucide-react';
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import { cn } from '../cn';
import { notify } from '../stores/app';
import { Button, Input } from './primitives';

/** One variable a `{{name}}` can reach, as the host's `api.variables.list` returns it. */
export interface VariableInfo {
  name: string;
  /** Null for built-in dynamic variables, which get a new value on every send. */
  value: string | null;
  secret: boolean;
  source: 'global' | 'environment' | 'dynamic';
  overridesGlobal?: boolean;
  help?: string;
}

export interface VariableScope {
  environment: { id: string; name: string } | null;
  variables: VariableInfo[];
}

/** Changes the value `{{name}}` resolves to, where it is defined. */
export type SaveVariable = (name: string, value: string) => Promise<void>;

/** The variables in reach, plus how to change one when the provider allows it. */
export interface VariableContext extends VariableScope {
  save?: SaveVariable;
}

const VariablesContext = createContext<VariableContext | null>(null);

/**
 * Makes `{{variables}}` inside VariableInput, KeyValueEditor and CodeEditor highlighted, with
 * their value on hover. Outside a provider those components behave as plain inputs. With
 * `onSave`, the hover card can also edit the value.
 */
export function VariablesProvider({ value, onSave, children }: { value: VariableScope | null | undefined; onSave?: SaveVariable; children: ReactNode }) {
  const context = useMemo(() => (value ? { ...value, save: onSave } : null), [value, onSave]);
  return <VariablesContext.Provider value={context}>{children}</VariablesContext.Provider>;
}

export function useVariables(): VariableContext | null {
  return useContext(VariablesContext);
}

export function lookupVariable(scope: VariableScope, name: string): VariableInfo | undefined {
  return scope.variables.find((v) => v.name === name);
}

// ---------- Hover card ----------

interface Card {
  name: string;
  info: VariableInfo | undefined;
  environment: VariableScope['environment'];
  anchor: { left: number; top: number; bottom: number };
  save?: SaveVariable;
}

interface HoverState {
  card: Card | null;
  revealed: boolean;
  /** Set while the value is being edited: the card then stays put until saved or cancelled. */
  editing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  show(card: Card): void;
  scheduleHide(): void;
  cancelHide(): void;
  hide(): void;
  toggleReveal(): void;
  setEditing(editing: boolean): void;
  /** Reflect a saved value in the open card until the next refresh of the variables. */
  setValue(value: string): void;
}

export const useVariableHoverStore = create<HoverState>((set, get) => ({
  card: null,
  revealed: false,
  editing: false,
  timer: null,
  show: (card) => {
    const { card: current, timer, editing } = get();
    if (editing) return;
    if (timer) clearTimeout(timer);
    const same = current?.name === card.name && current.anchor.left === card.anchor.left && current.anchor.top === card.anchor.top;
    set({ card, timer: null, revealed: same ? get().revealed : false });
  },
  // A short grace period lets the pointer travel from the variable into the card.
  scheduleHide: () => {
    const { timer, card, editing } = get();
    if (!card || timer || editing) return;
    set({ timer: setTimeout(() => set({ card: null, timer: null, revealed: false }), 180) });
  },
  cancelHide: () => {
    const { timer } = get();
    if (timer) clearTimeout(timer);
    set({ timer: null });
  },
  hide: () => {
    const { timer } = get();
    if (timer) clearTimeout(timer);
    set({ card: null, timer: null, revealed: false, editing: false });
  },
  toggleReveal: () => set({ revealed: !get().revealed }),
  setEditing: (editing) => {
    const { timer } = get();
    if (timer) clearTimeout(timer);
    set({ editing, timer: null });
  },
  setValue: (value) => {
    const { card } = get();
    if (card?.info) set({ card: { ...card, info: { ...card.info, value } } });
  },
}));

/** Show the card for the variable under the pointer. `rect` is the placeholder's box on screen. */
export function showVariableCard(scope: VariableContext, name: string, rect: DOMRect): void {
  useVariableHoverStore.getState().show({ name, info: lookupVariable(scope, name), environment: scope.environment, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom }, save: scope.save });
}

const MASK = '••••••••';

/** Renders the variable hover card. Mount once in the shell. */
export function VariableHoverHost() {
  const { card, revealed, editing, cancelHide, scheduleHide, hide, toggleReveal, setEditing, setValue } = useVariableHoverStore();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useLayoutEffect(() => {
    if (!card || !ref.current) return setPosition(null);
    const { width, height } = ref.current.getBoundingClientRect();
    const below = card.anchor.bottom + 6;
    const top = below + height > window.innerHeight - 4 ? Math.max(4, card.anchor.top - height - 6) : below;
    const left = Math.max(4, Math.min(card.anchor.left, window.innerWidth - width - 4));
    setPosition({ left, top });
  }, [card, revealed, editing, draft]);

  useLayoutEffect(() => {
    if (!card) return;
    const inside = (e: Event) => ref.current?.contains(e.target as Node) ?? false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape backs out of editing first, then closes the card.
      if (useVariableHoverStore.getState().editing) {
        e.stopPropagation();
        setEditing(false);
      } else hide();
    };
    const onDown = (e: MouseEvent) => !inside(e) && hide();
    // Scrolling the value inside the card must not close it; scrolling the page does.
    const onScroll = (e: Event) => !inside(e) && hide();
    // Switching windows keeps an edit in progress.
    const onBlur = () => !useVariableHoverStore.getState().editing && hide();
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [card, hide, setEditing]);

  if (!card) return null;
  const { info, name, environment, save } = card;
  const envName = environment?.name;
  const source = !info ? 'Not defined' : info.source === 'environment' ? `Environment · ${envName ?? ''}` : info.source === 'global' ? 'Global' : 'Built-in';
  const hidden = info?.secret && !revealed;
  const editable = Boolean(save && info && info.source !== 'dynamic');
  const note = editing
    ? info?.source === 'environment'
      ? `Saves to the ${envName ?? 'active'} environment${info.secret ? ', encrypted on this machine' : ''}. Enter saves, Shift+Enter adds a line.`
      : 'Saves to the global variables, which every workspace uses. Enter saves, Shift+Enter adds a line.'
    : !info
      ? envName
        ? `Not in the ${envName} environment or the global variables; it is sent as written.`
        : 'No environment is active and no global variable has this name; it is sent as written.'
      : info.source === 'dynamic'
        ? `${info.help ?? 'Built-in value'}, new on every send.`
        : info.secret
          ? 'Secret, stored encrypted on this machine.'
          : info.overridesGlobal
            ? 'Overrides the global variable of the same name.'
            : null;
  const copy = () => {
    if (info?.value == null) return;
    void navigator.clipboard.writeText(info.value).then(
      () => notify(`Copied the value of ${name}`, 'success'),
      () => notify('Could not copy to the clipboard', 'error'),
    );
  };
  const startEditing = () => {
    if (!editable) return;
    setDraft(info?.value ?? '');
    setEditing(true);
  };
  const commit = async () => {
    if (!save || saving) return;
    if (draft === info?.value) return setEditing(false);
    setSaving(true);
    try {
      await save(name, draft);
      setValue(draft);
      setEditing(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };
  const iconButton = 'rounded p-1 text-muted hover:text-fg hover:bg-surface';

  return (
    <div
      ref={ref}
      role={editing ? 'dialog' : 'tooltip'}
      aria-label={editing ? `Edit ${name}` : undefined}
      onMouseEnter={cancelHide}
      onMouseLeave={scheduleHide}
      style={position ?? { left: card.anchor.left, top: card.anchor.bottom + 6, visibility: 'hidden' }}
      className="fixed z-50 w-80 max-w-[calc(100vw-8px)] rounded-md border border-edge bg-elevated shadow-lg p-2.5 text-xs"
      data-testid="variable-card"
      data-name={name}
      data-editing={editing || undefined}
    >
      <div className="flex items-center gap-2 min-w-0">
        <code className={cn('font-mono font-semibold truncate', info ? 'text-fg' : 'text-danger')}>{`{{${name}}}`}</code>
        <span className="flex-1" />
        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', info ? 'bg-surface text-muted' : 'bg-danger/15 text-danger')} data-testid="variable-card-source">
          {source}
        </span>
      </div>

      {info && info.value !== null && (
        <div className="mt-2 flex items-start gap-1">
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void commit();
                }
              }}
              className={cn(
                'flex-1 min-w-0 field-sizing-content max-h-32 resize-none rounded border border-accent bg-surface px-2 py-1.5 font-mono text-fg break-all outline-none focus:ring-2 focus:ring-accent/30',
                hidden && '[-webkit-text-security:disc]',
              )}
              aria-label={`Value of ${name}`}
              data-testid="variable-card-input"
            />
          ) : (
            <div
              className={cn('flex-1 min-w-0 max-h-32 overflow-auto overscroll-contain rounded border border-edge bg-surface px-2 py-1.5 font-mono whitespace-pre-wrap break-all', info.value === '' && !hidden && 'italic text-muted')}
              onDoubleClick={startEditing}
              data-testid="variable-card-value"
            >
              {hidden ? MASK : info.value === '' ? '(empty)' : info.value}
            </div>
          )}
          <div className="flex flex-col gap-0.5 shrink-0">
            {info.secret && (
              <button type="button" onClick={toggleReveal} className={iconButton} title={revealed ? 'Hide value' : 'Show value'} aria-label={revealed ? 'Hide value' : 'Show value'} data-testid="variable-card-reveal">
                {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            )}
            {!editing && editable && (
              <button type="button" onClick={startEditing} className={iconButton} title="Edit value" aria-label="Edit value" data-testid="variable-card-edit">
                <Pencil className="size-3.5" />
              </button>
            )}
            {!editing && (
              <button type="button" onClick={copy} className={iconButton} title="Copy value" aria-label="Copy value">
                <Copy className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {note && <p className="mt-1.5 text-[11px] text-muted">{note}</p>}

      {editing && (
        <div className="mt-2 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => setEditing(false)} data-testid="variable-card-cancel">
            Cancel
          </Button>
          <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={saving} onClick={() => void commit()} data-testid="variable-card-save">
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- Input with highlighted placeholders ----------

export interface VariableInputProps extends InputHTMLAttributes<HTMLInputElement> {
  value: string;
  /** Classes for the wrapper, which takes the input's place in the layout. */
  wrapperClassName?: string;
}

/**
 * An Input that marks `{{variables}}` (unknown ones in red) and shows their value on hover.
 * A layer of translucent chips sits over the text, lined up with it and scrolled with it.
 */
export function VariableInput({ wrapperClassName, onScroll, onMouseMove, onMouseLeave, ...props }: VariableInputProps) {
  const scope = useVariables();
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const spans = scope ? findVariableSpans(props.value) : [];

  const sync = () => {
    const input = inputRef.current;
    const layer = layerRef.current;
    if (!input || !layer) return;
    const style = getComputedStyle(input);
    layer.style.font = style.font;
    layer.style.letterSpacing = style.letterSpacing;
    layer.style.paddingLeft = `${parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)}px`;
    layer.style.paddingRight = `${parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth)}px`;
    layer.scrollLeft = input.scrollLeft;
  };
  useLayoutEffect(sync);

  if (!scope) return <Input {...props} onScroll={onScroll} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} />;

  const pieces: ReactNode[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.from > at) pieces.push(props.value.slice(at, span.from));
    const known = Boolean(lookupVariable(scope, span.name));
    pieces.push(
      <span
        key={span.from}
        data-var-name={span.name}
        className={cn('rounded-sm', known ? 'bg-accent/20' : 'bg-danger/20 shadow-[inset_0_-1.5px_0_var(--danger)]')}
      >
        {props.value.slice(span.from, span.to)}
      </span>,
    );
    at = span.to;
  }
  if (at < props.value.length) pieces.push(props.value.slice(at));

  return (
    <div className={cn('relative w-full min-w-0', wrapperClassName)}>
      <Input
        {...props}
        ref={inputRef}
        onScroll={(e) => {
          sync();
          onScroll?.(e);
        }}
        onSelect={(e) => {
          sync();
          props.onSelect?.(e);
        }}
        onMouseMove={(e) => {
          onMouseMove?.(e);
          const hit = [...(layerRef.current?.querySelectorAll<HTMLElement>('[data-var-name]') ?? [])].find((el) => {
            const r = el.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          });
          if (hit) showVariableCard(scope, hit.dataset.varName!, hit.getBoundingClientRect());
          else useVariableHoverStore.getState().scheduleHide();
        }}
        onMouseLeave={(e) => {
          onMouseLeave?.(e);
          useVariableHoverStore.getState().scheduleHide();
        }}
        data-variables={spans.length ? spans.map((s) => s.name).join(',') : undefined}
      />
      <div ref={layerRef} aria-hidden className="absolute inset-0 flex items-center overflow-hidden whitespace-pre text-transparent pointer-events-none select-none rounded-md">
        <span className="shrink-0">{pieces}</span>
      </div>
    </div>
  );
}
