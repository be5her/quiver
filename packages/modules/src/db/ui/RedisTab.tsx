import { toErrorPayload, type ErrorPayload, type RedisKeyDetail, type RedisKeyInfo, type RedisScanResult } from '@quiver/core';
import { Badge, Button, CodeEditor, IconButton, Input, Spinner, cn, confirmDialog, invoke, notify, type TabProps } from '@quiver/ui';
import { Copy, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ResultGrid } from './ResultGrid';
import { DbError, REDIS_TYPE_COLORS, formatCount, formatTtl, redisQuote } from './shared';

const SCAN_COUNT = 200;

export function RedisTab({ tab }: TabProps) {
  const connectionId = String(tab.data?.connectionId ?? '');
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<RedisKeyInfo[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<ErrorPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const scan = useCallback(
    async (fresh: boolean) => {
      if (scanning) return;
      setScanning(true);
      setScanError(null);
      try {
        const out = await invoke<RedisScanResult>('db.redis.keys', { connectionId, pattern: pattern.trim() || '*', cursor: fresh ? '0' : (cursor ?? '0'), count: SCAN_COUNT });
        setKeys((prev) => {
          const merged = fresh ? out.keys : [...prev, ...out.keys.filter((k) => !prev.some((p) => p.key === k.key))];
          return merged.sort((a, b) => a.key.localeCompare(b.key));
        });
        setCursor(out.done ? null : out.cursor);
      } catch (err) {
        setScanError(toErrorPayload(err));
      } finally {
        setScanning(false);
      }
    },
    [connectionId, pattern, cursor, scanning],
  );

  useEffect(() => {
    void scan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const removeKey = (key: string) => {
    setKeys((prev) => prev.filter((k) => k.key !== key));
    if (selected === key) setSelected(null);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-80 shrink-0 border-r border-edge flex flex-col min-h-0">
        <div className="flex items-center gap-1 p-2 border-b border-edge">
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void scan(true)}
            placeholder="user:*"
            className="h-7 font-mono text-xs"
          />
          <IconButton label="Scan" size="sm" onClick={() => void scan(true)}>
            {scanning ? <Spinner className="size-3.5" /> : <Search className="size-3.5" />}
          </IconButton>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {scanError && <DbError error={scanError} onRetry={() => void scan(true)} compact />}
          {keys.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setSelected(k.key)}
              className={cn('w-full flex items-center gap-2 px-2 h-7 text-left hover:bg-elevated min-w-0', selected === k.key && 'bg-elevated')}
              title={`${k.key}\n${k.type} · ${formatTtl(k.ttl)}`}
            >
              <TypeBadge type={k.type} />
              <span className="truncate text-xs font-mono flex-1">{k.key}</span>
              {k.ttl >= 0 && <span className="text-[10px] text-muted shrink-0">{formatTtl(k.ttl)}</span>}
            </button>
          ))}
          {!scanning && !scanError && keys.length === 0 && <p className="p-3 text-xs text-muted">No keys match.</p>}
        </div>
        <div className="flex items-center justify-between px-2 h-8 border-t border-edge text-[11px] text-muted shrink-0">
          <span>{formatCount(keys.length)} keys{cursor ? '+' : ''}</span>
          {cursor && (
            <Button size="sm" variant="ghost" onClick={() => void scan(false)} loading={scanning}>
              Load more
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 min-w-0 min-h-0">
        {selected ? <KeyDetail connectionId={connectionId} keyName={selected} onDeleted={() => removeKey(selected)} /> : <div className="h-full flex items-center justify-center text-xs text-muted">Select a key to inspect it.</div>}
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  return <Badge className={cn('w-12 justify-center font-mono text-[10px]', REDIS_TYPE_COLORS[type] ?? '')}>{type}</Badge>;
}

function KeyDetail({ connectionId, keyName, onDeleted }: { connectionId: string; keyName: string; onDeleted(): void }) {
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await invoke<RedisKeyDetail>('db.redis.key', { connectionId, key: keyName, limit: 500 }));
      setError(null);
    } catch (err) {
      setError(toErrorPayload(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, keyName]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete key "${keyName}"?`, danger: true, confirmLabel: 'Delete' }))) return;
    try {
      await invoke('db.query.run', { connectionId, query: `DEL ${redisQuote(keyName)}`, record: false });
      notify('Key deleted', 'success');
      onDeleted();
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  };

  const copyValue = () => {
    if (!detail) return;
    const text = typeof detail.value === 'string' ? detail.value : JSON.stringify(detail.value, null, 2);
    void navigator.clipboard.writeText(text).then(() => notify('Copied value', 'success'));
  };

  if (error) return <DbError error={error} onRetry={() => void load()} />;
  if (!detail)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-edge shrink-0 min-w-0">
        <TypeBadge type={detail.type} />
        <span className="font-mono text-sm truncate" title={keyName}>
          {keyName}
        </span>
        <div className="flex-1" />
        {loading && <Spinner className="size-3.5" />}
        <IconButton label="Copy value" size="sm" onClick={copyValue}>
          <Copy className="size-3.5" />
        </IconButton>
        <IconButton label="Refresh" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        <IconButton label="Delete key" size="sm" onClick={() => void remove()} className="hover:text-danger">
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
      <div className="flex items-center gap-4 px-3 h-7 border-b border-edge shrink-0 text-[11px] text-muted">
        <span>TTL: {formatTtl(detail.ttl)}</span>
        {detail.length !== null && <span>{detail.type === 'string' ? 'length' : 'items'}: {formatCount(detail.length)}</span>}
        {detail.encoding && <span>encoding: {detail.encoding}</span>}
        {detail.memory !== null && <span>memory: {formatCount(detail.memory)} B</span>}
        {detail.truncated && <span className="text-warning">showing first {formatCount(Array.isArray(detail.value) ? detail.value.length : 500)}</span>}
      </div>
      <div className="flex-1 min-h-0">
        <ValueView detail={detail} />
      </div>
    </div>
  );
}

function ValueView({ detail }: { detail: RedisKeyDetail }) {
  const { type, value } = detail;
  const rows = useMemo<{ columns: { name: string; type: null }[]; rows: unknown[][] } | null>(() => {
    if (type === 'hash' && value && typeof value === 'object' && !Array.isArray(value)) {
      return { columns: [{ name: 'field', type: null }, { name: 'value', type: null }], rows: Object.entries(value as Record<string, unknown>) };
    }
    if ((type === 'list' || type === 'set') && Array.isArray(value)) {
      return { columns: [{ name: 'index', type: null }, { name: 'value', type: null }], rows: value.map((v, i) => [i, v]) };
    }
    if (type === 'zset' && Array.isArray(value)) {
      return { columns: [{ name: 'member', type: null }, { name: 'score', type: null }], rows: value as unknown[][] };
    }
    if (type === 'stream' && Array.isArray(value)) {
      return { columns: [{ name: 'id', type: null }, { name: 'fields', type: null }], rows: (value as { id: string; fields: unknown }[]).map((e) => [e.id, e.fields]) };
    }
    return null;
  }, [type, value]);

  if (rows) return <ResultGrid columns={rows.columns} rows={rows.rows} emptyMessage="(empty)" />;
  if (type === 'string') {
    const text = String(value ?? '');
    const json = tryPrettyJson(text);
    return (
      <div className="p-2 h-full">
        <CodeEditor value={json ?? text} language={json ? 'json' : 'text'} readOnly wrap />
      </div>
    );
  }
  return <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all overflow-auto h-full">{value === null ? `(${type} values are not previewed)` : JSON.stringify(value, null, 2)}</pre>;
}

function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}
