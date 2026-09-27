import {
  KUBE_CAN_I_VERBS,
  KUBE_OPERATIONS,
  KUBE_OUTPUTS,
  KUBE_RESOURCE_TYPES,
  KUBE_TAIL_MAX,
  buildKubectlArgs,
  formatKubectlCommand,
  kubeOperationInfo,
  kubeQueryErrors,
  newId,
  parseKubectlNames,
  parsePodContainers,
  toErrorPayload,
  type ErrorPayload,
  type KubeField,
  type KubeHistoryEntry,
  type KubeOperation,
  type KubeQuery,
  type KubeRunResult,
  type KubeStreamRead,
} from '@quiver/core';
import { Badge, Button, Checkbox, IconButton, Input, Select, Spinner, cn, confirmDialog, invoke, notify, onHostEvent, useInvoke, type TabProps } from '@quiver/ui';
import { Boxes, Copy, Play, Search, Square, Star, Terminal, Trash2, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DbError, formatDuration } from '../../db/ui/shared';

type Values = Record<string, string | number | boolean | undefined>;

/** Lines kept in the output panel while following logs; older ones scroll away. */
const FOLLOW_BUFFER = 5000;
const DEFAULT_TAIL = 200;

const report = (err: unknown) => notify(toErrorPayload(err).message, 'error');

/** Form values to a query: empty fields and unticked flags are left out, numbers are parsed. */
function toQuery(operation: KubeOperation, values: Values): KubeQuery {
  const info = kubeOperationInfo(operation);
  const params: Record<string, unknown> = {};
  for (const field of info?.fields ?? []) {
    const v = values[field.key];
    if (v === undefined || v === '' || v === false) continue;
    if (field.kind === 'tail') params[field.key] = typeof v === 'number' ? v : /^\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : v;
    else if (typeof v === 'string') params[field.key] = v.trim();
    else params[field.key] = v;
  }
  return { operation, params } as KubeQuery;
}

/** A history entry's parameters in a few words, e.g. `pods · payments · app=api`. */
function summarize(q: KubeQuery): string {
  const p = q.params as Record<string, unknown>;
  const parts = [p.verb, p.resource, p.name ?? p.pod ?? p.deployment, p.allNamespaces ? 'all namespaces' : p.namespace, p.container, p.selector, p.tail !== undefined ? `tail ${p.tail}` : undefined, p.since ? `since ${p.since}` : undefined, p.output];
  return parts.filter((x) => x !== undefined && x !== '').join(' · ');
}

function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * One Kubernetes cluster reached through Teleport: pick a read-only operation, fill in its typed
 * fields and run it with `tsh kubectl`. There is no free-form command line anywhere; the preview
 * shows what the host will run and is not editable.
 */
export function KubeQueryTab({ tab }: TabProps) {
  const proxy = String(tab.data?.proxy ?? '');
  const cluster = String(tab.data?.cluster ?? '');
  const [operation, setOperation] = useState<KubeOperation>('list');
  const [values, setValues] = useState<Values>({ resource: 'pods' });
  const [running, setRunning] = useState<{ runId: string; streaming: boolean } | null>(null);
  const [result, setResult] = useState<KubeRunResult | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [stream, setStream] = useState<KubeStreamRead | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const nextRef = useRef(0);
  const namespaceSeeded = useRef(false);

  const history = useHistory(proxy, cluster);
  const lookups = useLookups(proxy, cluster);

  // The namespace last used on this cluster comes back from its history.
  useEffect(() => {
    if (namespaceSeeded.current || !history.data) return;
    namespaceSeeded.current = true;
    const ns = history.data.lastNamespace;
    if (ns) setValues((v) => (v.namespace ? v : { ...v, namespace: ns }));
  }, [history.data]);

  const query = useMemo(() => toQuery(operation, values), [operation, values]);
  const errors = useMemo(() => kubeQueryErrors(query), [query]);
  const valid = Object.keys(errors).length === 0;
  const preview = useMemo(() => (valid ? formatKubectlCommand(buildKubectlArgs(query.operation, query.params)) : null), [valid, query]);
  const info = kubeOperationInfo(operation)!;

  const set = (key: string, value: Values[string]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setTouched((t) => ({ ...t, [key]: true }));
  };

  const pickOperation = (next: KubeOperation) => {
    setOperation(next);
    setTouched({});
    setValues((v) => {
      const keep: Values = { namespace: v.namespace, resource: v.resource ?? 'pods', pod: v.pod, container: v.container };
      if ((next === 'logs' || next === 'logs-follow') && v.tail === undefined) keep.tail = next === 'logs' ? DEFAULT_TAIL : 100;
      else keep.tail = v.tail;
      if (next === 'can-i') keep.verb = v.verb ?? 'get';
      return keep;
    });
  };

  // Follow-logs: pull new lines whenever the host says the stream moved.
  const pull = useCallback(async (runId: string) => {
    try {
      const read = await invoke<KubeStreamRead>('teleport.kube.stream.read', { runId, since: nextRef.current }, null);
      nextRef.current = read.next;
      setStream(read);
      if (read.lines.length) setLines((prev) => { const merged = prev.concat(read.lines); return merged.length > FOLLOW_BUFFER ? merged.slice(merged.length - FOLLOW_BUFFER) : merged; });
      if (!read.running) setRunning((r) => (r?.runId === runId ? null : r));
    } catch (err) {
      setError(toErrorPayload(err));
      setRunning((r) => (r?.runId === runId ? null : r));
    }
  }, []);

  useEffect(() => {
    if (!running?.streaming) return;
    const runId = running.runId;
    return onHostEvent('teleport.kube.changed', (p) => {
      if (p.reason === 'stream' && p.runId === runId) void pull(runId);
    });
  }, [running, pull]);

  const run = async (q: KubeQuery = query) => {
    if (running) return;
    const runId = newId();
    const streaming = Boolean(kubeOperationInfo(q.operation)?.streaming);
    setRunning({ runId, streaming });
    setError(null);
    setStream(null);
    setResult(null);
    setLines([]);
    nextRef.current = 0;
    try {
      const out = await invoke<KubeRunResult>('teleport.kube.query', { proxy, cluster, query: q, runId }, null);
      setResult(out);
      if (out.streaming) {
        await pull(runId);
      } else {
        setLines(out.stdout ? out.stdout.split('\n') : []);
        setRunning(null);
      }
    } catch (err) {
      setError(toErrorPayload(err));
      setRunning(null);
    }
  };

  const stop = () => {
    if (running) void invoke('teleport.kube.cancel', { runId: running.runId }, null).catch(report);
  };

  // Stop a followed log when its tab closes.
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => () => {
    const r = runningRef.current;
    if (r) void invoke('teleport.kube.cancel', { runId: r.runId }, null).catch(() => {});
  }, []);

  const fillFrom = (entry: KubeHistoryEntry) => {
    setOperation(entry.query.operation);
    setValues({ ...(entry.query.params as Values) });
    setTouched({});
  };

  const setTerminalContext = async () => {
    const ok = await confirmDialog({
      title: `Point your terminal's kubectl at ${cluster}?`,
      message: 'This runs tsh kube login, which changes the current context in the kubeconfig your terminals use. Queries in this view never need it.',
      confirmLabel: 'Set terminal context',
    });
    if (!ok) return;
    try {
      await invoke('teleport.kube.login', { proxy, cluster }, null);
      notify(`kubectl in your terminals now points at ${cluster}`, 'success');
    } catch (err) {
      report(err);
    }
  };

  const namespace = typeof values.namespace === 'string' && values.namespace.trim() ? values.namespace.trim() : 'default';
  const exitCode = stream ? stream.exitCode : result?.exitCode;
  const durationMs = stream ? stream.durationMs : result?.durationMs;
  const stderr = stream ? stream.stderr : result?.stderr;

  return (
    <div className="flex h-full min-h-0" data-testid="kube-query" data-cluster={cluster}>
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0">
          <Boxes className="size-4 text-accent shrink-0" />
          <span className="font-medium text-sm shrink-0">{cluster}</span>
          <span className="text-xs text-muted truncate min-w-0" title={proxy}>
            via {proxy}
          </span>
          <div className="flex-1" />
          <Button size="sm" className="whitespace-nowrap shrink-0" icon={<Terminal className="size-3.5" />} onClick={() => void setTerminalContext()} title="Runs tsh kube login: changes the current kubectl context in your terminals" data-testid="kube-terminal-context">
            Set as kubectl context for my terminal
          </Button>
        </div>

        <div className="px-3 pt-3 pb-2 border-b border-edge shrink-0 flex flex-col gap-2.5">
          <div className="flex items-end gap-3 flex-wrap">
            <FieldBox label="Operation">
              <Select value={operation} onChange={(e) => pickOperation(e.target.value as KubeOperation)} className="w-48" data-testid="kube-operation">
                {KUBE_OPERATIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </Select>
            </FieldBox>
            {info.fields.map((field) => (
              <FieldEditor
                key={`${operation}:${field.key}`}
                field={field}
                values={values}
                error={touched[field.key] || values[field.key] !== undefined ? errors[field.key] : undefined}
                onChange={(v) => set(field.key, v)}
                lookups={lookups}
                namespace={namespace}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md border border-edge bg-canvas px-2.5 h-8 leading-8 text-xs font-mono text-muted select-all" title={preview ?? undefined} data-testid="kube-preview">
              {preview ?? 'Fill in the required fields to see the command'}
            </code>
            {running ? (
              <Button size="md" variant="danger" icon={<Square className="size-3.5" />} onClick={stop} data-testid="kube-stop">
                {running.streaming ? 'Stop' : 'Cancel'}
              </Button>
            ) : (
              <Button size="md" variant="primary" icon={<Play className="size-3.5" />} disabled={!valid} onClick={() => void run()} data-testid="kube-run">
                Run
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted -mt-1">
            {info.description}. Read-only, and your terminal's kubectl context is not changed. The preview is for reference: the host builds the command from this form, never from text.
          </p>
        </div>

        <OutputPanel
          lines={lines}
          stderr={stderr ?? ''}
          exitCode={exitCode}
          durationMs={durationMs}
          running={running}
          truncated={Boolean(result?.truncated) || (stream?.dropped ?? 0) > 0}
          error={error}
          onRetry={() => void run()}
          hasResult={Boolean(result) || Boolean(error)}
        />
      </div>

      <HistoryPanel history={history} onFill={fillFrom} onRerun={(e) => { fillFrom(e); void run(e.query); }} proxy={proxy} cluster={cluster} busy={Boolean(running)} />
    </div>
  );
}

// ---------- form ----------

function FieldBox({ label, error, children, className }: { label: string; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1 min-w-0', className)}>
      <span className="text-[11px] font-medium text-muted">{label}</span>
      {children}
      <span className={cn('text-[11px] h-3.5 leading-3.5 truncate', error ? 'text-danger' : 'text-transparent')} title={error}>
        {error ?? '.'}
      </span>
    </div>
  );
}

interface Lookups {
  namespaces: string[];
  names(resource: string, namespace: string): string[];
  containers(namespace: string, pod: string): string[];
}

function FieldEditor({ field, values, error, onChange, lookups, namespace }: { field: KubeField; values: Values; error?: string; onChange(v: Values[string]): void; lookups: Lookups; namespace: string }) {
  const value = values[field.key];
  const text = (props: { list?: string; placeholder?: string; width?: string; inputMode?: 'numeric' }) => (
    <Input
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      list={props.list}
      placeholder={props.placeholder}
      inputMode={props.inputMode}
      className={cn(props.width ?? 'w-44', 'font-mono text-xs', error && 'border-danger focus:border-danger focus:ring-danger/30')}
      aria-invalid={Boolean(error)}
      data-testid={`kube-field-${field.key}`}
    />
  );
  const listId = (suffix: string) => `kube-${field.key}-${suffix}`;

  switch (field.kind) {
    case 'resource':
      return (
        <FieldBox label={field.label} error={error}>
          <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)} className="w-48" data-testid={`kube-field-${field.key}`}>
            {!value && <option value="">Pick a type</option>}
            {KUBE_RESOURCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FieldBox>
      );
    case 'verb':
      return (
        <FieldBox label={field.label} error={error}>
          <Select value={String(value ?? 'get')} onChange={(e) => onChange(e.target.value)} className="w-36" data-testid={`kube-field-${field.key}`}>
            {KUBE_CAN_I_VERBS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </FieldBox>
      );
    case 'output':
      return (
        <FieldBox label={field.label} error={error}>
          <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)} className="w-28" data-testid={`kube-field-${field.key}`}>
            <option value="">table</option>
            {KUBE_OUTPUTS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </FieldBox>
      );
    case 'namespace':
      return (
        <FieldBox label={field.label} error={error}>
          <fieldset disabled={Boolean(values.allNamespaces)} className="contents">
            {text({ list: listId('options'), placeholder: 'default' })}
          </fieldset>
          <datalist id={listId('options')}>
            {lookups.namespaces.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </FieldBox>
      );
    case 'pod':
    case 'name':
    case 'deployment': {
      const resource = field.kind === 'pod' ? 'pods' : field.kind === 'deployment' ? 'deployments' : String(values.resource ?? '');
      const options = resource ? lookups.names(resource, namespace) : [];
      return (
        <FieldBox label={field.label} error={error}>
          {text({ list: listId('options'), placeholder: field.kind === 'pod' ? 'pod name' : 'name', width: 'w-60' })}
          <datalist id={listId('options')}>
            {options.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </FieldBox>
      );
    }
    case 'container': {
      const pod = typeof values.pod === 'string' ? values.pod.trim() : '';
      const options = pod ? lookups.containers(namespace, pod) : [];
      return (
        <FieldBox label={field.label} error={error}>
          <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value || undefined)} className="w-40" data-testid={`kube-field-${field.key}`}>
            <option value="">(default)</option>
            {[...new Set([...options, ...(typeof value === 'string' && value ? [value] : [])])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </FieldBox>
      );
    }
    case 'selector':
      return <FieldBox label={field.label} error={error}>{text({ placeholder: 'app=api', width: 'w-48' })}</FieldBox>;
    case 'tail':
      return <FieldBox label={field.label} error={error}>{text({ placeholder: `1-${KUBE_TAIL_MAX}`, width: 'w-24', inputMode: 'numeric' })}</FieldBox>;
    case 'since':
      return <FieldBox label={field.label} error={error}>{text({ placeholder: '15m', width: 'w-20' })}</FieldBox>;
    case 'allNamespaces':
    case 'flag':
      return (
        <FieldBox label={' '} error={error}>
          <label className="flex items-center gap-1.5 h-8 text-xs cursor-pointer select-none">
            <Checkbox checked={Boolean(value)} onChange={(e) => onChange(e.target.checked || undefined)} data-testid={`kube-field-${field.key}`} />
            {field.label}
          </label>
        </FieldBox>
      );
  }
}

/**
 * Picker data from the same catalogue: namespaces from `namespaces`, names from `list` of the
 * chosen type, containers from `get pods <name> -o json`. None of these land in the history.
 */
function useLookups(proxy: string, cluster: string): Lookups {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string[]>>({});
  const [containers, setContainers] = useState<Record<string, string[]>>({});
  const pending = useRef(new Set<string>());

  const lookup = useCallback(
    async (key: string, query: KubeQuery, parse: (stdout: string) => string[], store: (key: string, list: string[]) => void) => {
      if (pending.current.has(key)) return;
      pending.current.add(key);
      try {
        const out = await invoke<KubeRunResult>('teleport.kube.query', { proxy, cluster, query, record: false, timeoutSeconds: 30 }, null);
        store(key, out.exitCode === 0 ? parse(out.stdout) : []);
      } catch {
        store(key, []);
      }
    },
    [proxy, cluster],
  );

  useEffect(() => {
    void lookup('namespaces', { operation: 'namespaces', params: {} }, parseKubectlNames, (_k, list) => setNamespaces(list));
  }, [lookup]);

  return {
    namespaces,
    names: (resource, namespace) => {
      const key = `${resource}\n${namespace}`;
      if (!(key in names) && (KUBE_RESOURCE_TYPES as readonly string[]).includes(resource)) {
        void lookup(key, { operation: 'list', params: { resource, namespace } } as KubeQuery, parseKubectlNames, (k, list) => setNames((m) => ({ ...m, [k]: list })));
      }
      return names[key] ?? [];
    },
    containers: (namespace, pod) => {
      const key = `${namespace}\n${pod}`;
      if (!(key in containers) && kubeQueryErrors({ operation: 'get', params: { resource: 'pods', name: pod, namespace } }).name === undefined) {
        void lookup(key, { operation: 'get', params: { resource: 'pods', name: pod, namespace, output: 'json' } }, parsePodContainers, (k, list) => setContainers((m) => ({ ...m, [k]: list })));
      }
      return containers[key] ?? [];
    },
  };
}

// ---------- output ----------

function OutputPanel({
  lines,
  stderr,
  exitCode,
  durationMs,
  running,
  truncated,
  error,
  onRetry,
  hasResult,
}: {
  lines: string[];
  stderr: string;
  exitCode: number | null | undefined;
  durationMs: number | undefined;
  running: { streaming: boolean } | null;
  truncated: boolean;
  error: ErrorPayload | null;
  onRetry(): void;
  hasResult: boolean;
}) {
  const [search, setSearch] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const term = search.trim().toLowerCase();
  const matches = useMemo(() => (term ? lines.reduce((n, l) => n + (l.toLowerCase().includes(term) ? 1 : 0), 0) : 0), [lines, term]);
  const shown = useMemo(() => (term && onlyMatches ? lines.filter((l) => l.toLowerCase().includes(term)) : lines), [lines, term, onlyMatches]);

  useEffect(() => {
    if (running?.streaming && follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, running, follow]);

  const copy = () => void navigator.clipboard.writeText(lines.join('\n')).then(() => notify('Output copied', 'success'));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-edge shrink-0 text-xs">
        {running ? (
          <span className="flex items-center gap-1.5 text-muted" data-testid="kube-status" data-state="running">
            <Spinner className="size-3.5" /> {running.streaming ? 'Following…' : 'Running…'}
          </span>
        ) : hasResult && !error ? (
          <span className="flex items-center gap-2" data-testid="kube-status" data-state="done" data-exit={exitCode ?? ''}>
            <Badge className={cn('font-mono', exitCode === 0 ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger')}>exit {exitCode ?? '–'}</Badge>
            {durationMs !== undefined && <span className="text-muted">{formatDuration(durationMs)}</span>}
            <span className="text-muted">
              {lines.length} line{lines.length === 1 ? '' : 's'}
            </span>
            {truncated && <span className="text-warning">output capped</span>}
          </span>
        ) : (
          <span className="text-muted">Output</span>
        )}
        <div className="flex-1" />
        {running?.streaming && (
          <label className="flex items-center gap-1 text-muted cursor-pointer select-none">
            <Checkbox checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Scroll to end
          </label>
        )}
        <div className="relative">
          <Search className="size-3.5 text-muted absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search output" className="h-7 w-48 pl-7 text-xs" data-testid="kube-search" />
        </div>
        {term && (
          <>
            <span className="text-muted tabular-nums" data-testid="kube-matches">
              {matches} match{matches === 1 ? '' : 'es'}
            </span>
            <label className="flex items-center gap-1 text-muted cursor-pointer select-none">
              <Checkbox checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} /> Only matches
            </label>
            <IconButton label="Clear search" size="sm" onClick={() => setSearch('')}>
              <X className="size-3.5" />
            </IconButton>
          </>
        )}
        <IconButton label="Copy output" size="sm" onClick={copy} disabled={!lines.length}>
          <Copy className="size-3.5" />
        </IconButton>
      </div>
      {error && (
        <div className="p-2 shrink-0">
          <DbError error={error} onRetry={onRetry} />
        </div>
      )}
      <div ref={scroller} className="flex-1 min-h-0 overflow-auto bg-canvas" data-testid="kube-output">
        {stderr.trim() && <pre className="px-3 pt-2 text-xs font-mono whitespace-pre-wrap break-all text-danger">{stderr.trimEnd()}</pre>}
        {shown.length > 0 ? (
          <pre className="px-3 py-2 text-xs font-mono leading-5 whitespace-pre">
            {shown.map((line, i) => (
              <Fragment key={i}>
                <Highlight line={line} term={term} />
                {'\n'}
              </Fragment>
            ))}
          </pre>
        ) : (
          !running && !stderr.trim() && !error && <p className="px-3 py-6 text-xs text-muted text-center">{hasResult ? 'No output.' : 'Pick an operation and run it. Output appears here.'}</p>
        )}
      </div>
    </div>
  );
}

function Highlight({ line, term }: { line: string; term: string }) {
  if (!term) return <>{line}</>;
  const lower = line.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, at)) {
    parts.push(line.slice(at, i), <mark key={i} className="bg-warning/40 text-fg rounded-sm">{line.slice(i, i + term.length)}</mark>);
    at = i + term.length;
  }
  parts.push(line.slice(at));
  return <>{parts}</>;
}

// ---------- history ----------

interface HistoryData {
  entries: KubeHistoryEntry[];
  lastNamespace: string | null;
}

function useHistory(proxy: string, cluster: string) {
  const history = useInvoke<HistoryData>('teleport.kube.history.list', { proxy, cluster }, { workspaceId: null });
  const { refresh } = history;
  useEffect(() => onHostEvent('teleport.kube.changed', (p) => p.reason === 'history' && void refresh()), [refresh]);
  return history;
}

function HistoryPanel({ history, onFill, onRerun, proxy, cluster, busy }: { history: ReturnType<typeof useHistory>; onFill(e: KubeHistoryEntry): void; onRerun(e: KubeHistoryEntry): void; proxy: string; cluster: string; busy: boolean }) {
  const entries = history.data?.entries ?? [];
  const pinned = entries.filter((e) => e.pinned);
  const recent = entries.filter((e) => !e.pinned);
  const clear = async () => {
    if (!(await confirmDialog({ title: `Clear the history of ${cluster}?`, message: 'Favourites stay. The history lives only on this machine.', confirmLabel: 'Clear', danger: true }))) return;
    await invoke('teleport.kube.history.clear', { proxy, cluster }, null).catch(report);
  };
  const row = (e: KubeHistoryEntry) => (
    <div
      key={e.id}
      role="button"
      tabIndex={0}
      onClick={() => onFill(e)}
      onKeyDown={(ev) => ev.key === 'Enter' && onFill(e)}
      className="group flex flex-col gap-0.5 px-3 py-1.5 hover:bg-elevated cursor-pointer min-w-0"
      title="Fill the form with this query"
      data-testid="kube-history-entry"
      data-operation={e.query.operation}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('size-1.5 rounded-full shrink-0', e.exitCode === 0 ? 'bg-success' : e.exitCode === null ? 'bg-muted' : 'bg-danger')} title={`exit ${e.exitCode ?? '–'}`} />
        <span className="text-[13px] truncate flex-1">{kubeOperationInfo(e.query.operation)?.title ?? e.query.operation}</span>
        <span className="text-[10px] text-muted shrink-0 group-hover:hidden">{ago(e.at)}</span>
        <span className="hidden group-hover:flex items-center shrink-0">
          <IconButton label="Run again" size="sm" disabled={busy} onClick={(ev) => { ev.stopPropagation(); onRerun(e); }}>
            <Play className="size-3" />
          </IconButton>
          <IconButton label={e.pinned ? 'Remove from favourites' : 'Add to favourites'} size="sm" onClick={(ev) => { ev.stopPropagation(); void invoke('teleport.kube.history.pin', { id: e.id }, null).catch(report); }}>
            <Star className={cn('size-3', e.pinned && 'fill-current text-warning')} />
          </IconButton>
          <IconButton label="Delete" size="sm" onClick={(ev) => { ev.stopPropagation(); void invoke('teleport.kube.history.delete', { id: e.id }, null).catch(report); }}>
            <Trash2 className="size-3" />
          </IconButton>
        </span>
      </div>
      <div className="pl-3 text-[11px] text-muted font-mono truncate">{summarize(e.query) || '—'}</div>
    </div>
  );
  return (
    <aside className="w-72 shrink-0 border-l border-edge flex flex-col min-h-0" data-testid="kube-history">
      <div className="flex items-center justify-between px-3 h-10 border-b border-edge shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">History</span>
        <IconButton label="Clear history" size="sm" onClick={() => void clear()} disabled={!recent.length}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {history.error && <DbError error={history.error} onRetry={() => void history.refresh()} compact />}
        {pinned.length > 0 && (
          <>
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Favourites</div>
            {pinned.map(row)}
          </>
        )}
        {pinned.length > 0 && recent.length > 0 && <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Recent</div>}
        {recent.map(row)}
        {!entries.length && !history.loading && <p className="px-3 py-4 text-xs text-muted">Queries you run on {cluster} show up here. Stored on this machine only.</p>}
      </div>
    </aside>
  );
}
