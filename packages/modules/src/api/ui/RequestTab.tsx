import { HttpMethodSchema, toErrorPayload, type ApiRequest, type ApiResponse, type HttpMethod, type KeyValue, type RequestAuth, type RequestBody } from '@quiver/core';
import {
  Button,
  CodeEditor,
  Input,
  KeyValueEditor,
  Label,
  METHOD_COLORS,
  Segmented,
  Select,
  Spinner,
  cn,
  invoke,
  notify,
  useTabsStore,
  type TabProps,
} from '@quiver/ui';
import { Copy, Save, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GraphqlEditor } from './GraphqlEditor';
import { ResponsePane } from './ResponsePane';

type Section = 'params' | 'headers' | 'body' | 'auth';

export function RequestTab({ tab, scope }: TabProps) {
  const requestId = String(tab.data?.id ?? '');
  const draft = tab.data?.draft as ApiRequest | undefined;
  const [request, setRequest] = useState<ApiRequest | null>(draft ?? null);
  const [saved, setSaved] = useState<ApiRequest | null>(draft ? null : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('params');
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const updateTab = useTabsStore((s) => s.updateTab);

  useEffect(() => {
    if (draft) return;
    let cancelled = false;
    invoke<ApiRequest>('api.request.get', { id: requestId })
      .then((r) => {
        if (cancelled) return;
        setRequest(r);
        setSaved(r);
      })
      .catch((err) => !cancelled && setLoadError(toErrorPayload(err).message));
    return () => {
      cancelled = true;
    };
  }, [requestId, draft]);

  const dirty = useMemo(() => {
    if (!request) return false;
    if (draft && !saved) return true;
    return JSON.stringify(request) !== JSON.stringify(saved);
  }, [request, saved, draft]);

  useEffect(() => {
    if (tab.dirty !== dirty) updateTab(scope, tab.id, { dirty });
  }, [dirty, scope, tab.id, tab.dirty, updateTab]);

  const patch = useCallback((p: Partial<ApiRequest>) => setRequest((r) => (r ? { ...r, ...p } : r)), []);

  const save = useCallback(async () => {
    if (!request) return;
    try {
      const stored = await invoke<ApiRequest>('api.request.save', { request });
      setRequest(stored);
      setSaved(stored);
      updateTab(scope, tab.id, { title: stored.name, data: { id: stored.id } });
      notify('Saved', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [request, scope, tab.id, updateTab]);

  const send = useCallback(async () => {
    if (!request || sending) return;
    setSending(true);
    setSendError(null);
    try {
      setResponse(await invoke<ApiResponse>('api.request.send', { request }));
    } catch (err) {
      setSendError(toErrorPayload(err).message);
    } finally {
      setSending(false);
    }
  }, [request, sending]);

  const copyCurl = useCallback(async () => {
    if (!request) return;
    try {
      const { command } = await invoke<{ command: string }>('api.export.curl', { request });
      await navigator.clipboard.writeText(command);
      notify('Copied curl command', 'success');
    } catch (err) {
      notify(toErrorPayload(err).message, 'error');
    }
  }, [request]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      void send();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };

  if (loadError) return <div className="p-4 text-sm text-danger">{loadError}</div>;
  if (!request)
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );

  const bodyCount = request.body.type === 'none' ? 0 : 1;
  const sectionLabel = (label: string, count: number) => (
    <span className="flex items-center gap-1">
      {label}
      {count > 0 && <span className="text-[10px] rounded-full bg-elevated px-1.5 text-muted">{count}</span>}
    </span>
  );

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge shrink-0">
        <Input
          value={request.name}
          onChange={(e) => patch({ name: e.target.value })}
          className="w-56 h-7 text-sm font-medium border-transparent bg-transparent hover:border-edge"
          placeholder="Request name"
        />
        <div className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => void copyCurl()}>
          curl
        </Button>
        <Button size="sm" variant={dirty ? 'secondary' : 'ghost'} icon={<Save className="size-3.5" />} onClick={() => void save()} title="Ctrl+S">
          Save{dirty ? '*' : ''}
        </Button>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <Select value={request.method} onChange={(e) => patch({ method: e.target.value as HttpMethod })} className={cn('font-bold w-28', METHOD_COLORS[request.method])}>
          {HttpMethodSchema.options.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <Input
          value={request.url}
          onChange={(e) => patch({ url: e.target.value })}
          placeholder="https://{{baseUrl}}/path"
          className="font-mono"
          autoFocus={!request.url}
        />
        <Button variant="primary" icon={<Send className="size-3.5" />} loading={sending} onClick={() => void send()} title="Ctrl+Enter">
          Send
        </Button>
      </div>

      <div className="flex flex-col flex-1 min-h-0">
        <div className={cn('flex flex-col min-h-[140px] border-b border-edge', request.body.type === 'graphql' && section === 'body' ? 'basis-[60%]' : 'basis-[45%]')}>
          <Segmented<Section>
            value={section}
            onChange={setSection}
            className="px-3 shrink-0"
            options={[
              { value: 'params', label: sectionLabel('Params', request.params.filter((p) => p.enabled && p.key).length) },
              { value: 'headers', label: sectionLabel('Headers', request.headers.filter((h) => h.enabled && h.key).length) },
              { value: 'body', label: sectionLabel('Body', bodyCount) },
              { value: 'auth', label: sectionLabel('Auth', request.auth.type === 'none' ? 0 : 1) },
            ]}
          />
          <div className="flex-1 min-h-0 overflow-auto p-2">
            {section === 'params' && <KeyValueEditor rows={request.params} onChange={(params) => patch({ params })} keyPlaceholder="Parameter" />}
            {section === 'headers' && <KeyValueEditor rows={request.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />}
            {section === 'body' && <BodyEditor body={request.body} onChange={(body) => patch({ body })} request={request} />}
            {section === 'auth' && <AuthEditor auth={request.auth} onChange={(auth) => patch({ auth })} />}
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <ResponsePane response={response} error={sendError} sending={sending} />
        </div>
      </div>
    </div>
  );
}

const BODY_TYPES: { value: RequestBody['type']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'urlencoded', label: 'Form URL-encoded' },
  { value: 'form', label: 'Multipart form' },
  { value: 'graphql', label: 'GraphQL' },
];

function BodyEditor({ body, onChange, request }: { body: RequestBody; onChange(body: RequestBody): void; request: ApiRequest }) {
  const setType = (type: RequestBody['type']) => {
    if (type === body.type) return;
    const content = 'content' in body ? body.content : body.type === 'graphql' ? body.query : '';
    const fields: KeyValue[] = 'fields' in body ? body.fields : [];
    switch (type) {
      case 'none':
        return onChange({ type });
      case 'urlencoded':
      case 'form':
        return onChange({ type, fields });
      case 'graphql':
        return onChange({ type, query: content, variables: '' });
      default:
        return onChange({ type, content });
    }
  };
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex items-center gap-2">
        <Select value={body.type} onChange={(e) => setType(e.target.value as RequestBody['type'])} className="h-7 text-xs">
          {BODY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      {'content' in body && (
        <div className="flex-1 min-h-[80px]">
          <CodeEditor value={body.content} onChange={(content) => onChange({ ...body, content })} language={body.type === 'json' ? 'json' : body.type === 'xml' ? 'xml' : 'text'} placeholder={body.type === 'json' ? '{\n  "key": "value"\n}' : ''} />
        </div>
      )}
      {'fields' in body && <KeyValueEditor rows={body.fields} onChange={(fields) => onChange({ ...body, fields })} keyPlaceholder="Field" />}
      {body.type === 'graphql' && (
        <div className="flex-1 min-h-0">
          <GraphqlEditor body={body} onChange={onChange} request={request} />
        </div>
      )}
      {body.type === 'none' && <p className="text-xs text-muted px-1">This request has no body.</p>}
    </div>
  );
}

export function AuthEditor({ auth, onChange }: { auth: RequestAuth; onChange(auth: RequestAuth): void }) {
  const setType = (type: RequestAuth['type']) => {
    switch (type) {
      case 'none':
        return onChange({ type });
      case 'bearer':
        return onChange({ type, token: '' });
      case 'basic':
        return onChange({ type, username: '', password: '' });
      case 'apikey':
        return onChange({ type, key: 'X-API-Key', value: '', in: 'header' });
    }
  };
  return (
    <div className="flex flex-col gap-3 max-w-lg">
      <div>
        <Label>Type</Label>
        <Select value={auth.type} onChange={(e) => setType(e.target.value as RequestAuth['type'])}>
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic</option>
          <option value="apikey">API key</option>
        </Select>
      </div>
      {auth.type === 'bearer' && (
        <div>
          <Label>Token</Label>
          <Input className="font-mono" value={auth.token} onChange={(e) => onChange({ ...auth, token: e.target.value })} placeholder="{{token}}" />
        </div>
      )}
      {auth.type === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Username</Label>
            <Input value={auth.username} onChange={(e) => onChange({ ...auth, username: e.target.value })} />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={auth.password} onChange={(e) => onChange({ ...auth, password: e.target.value })} />
          </div>
        </div>
      )}
      {auth.type === 'apikey' && (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <div>
            <Label>Key</Label>
            <Input className="font-mono" value={auth.key} onChange={(e) => onChange({ ...auth, key: e.target.value })} />
          </div>
          <div>
            <Label>Value</Label>
            <Input className="font-mono" value={auth.value} onChange={(e) => onChange({ ...auth, value: e.target.value })} />
          </div>
          <div>
            <Label>Add to</Label>
            <Select value={auth.in} onChange={(e) => onChange({ ...auth, in: e.target.value as 'header' | 'query' })}>
              <option value="header">Header</option>
              <option value="query">Query</option>
            </Select>
          </div>
        </div>
      )}
      <p className="text-xs text-muted">Reference environment variables anywhere with {'{{name}}'}. Keep secrets in an environment and mark them secret.</p>
    </div>
  );
}
