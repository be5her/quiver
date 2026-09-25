import type { ApiResponse } from '@quiver/core';
import { Button, CodeEditor, EmptyState, Segmented, Spinner, cn, formatBytes, formatMs, notify, statusColor, type CodeLanguage } from '@quiver/ui';
import { Copy } from 'lucide-react';
import { useMemo, useState } from 'react';

type View = 'body' | 'headers' | 'request';

export function ResponsePane({ response, error, sending }: { response: ApiResponse | null; error: string | null; sending: boolean }) {
  const [view, setView] = useState<View>('body');
  const [pretty, setPretty] = useState(true);

  const { text, language } = useMemo(() => formatBody(response, pretty), [response, pretty]);

  if (sending && !response) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-sm text-muted">
        <Spinner /> Sending…
      </div>
    );
  }
  if (error && !response) return <EmptyState title="Request failed" hint={error} />;
  if (!response) return <EmptyState title="No response yet" hint="Press Send or Ctrl+Enter." />;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-3 h-8 border-b border-edge text-xs shrink-0">
        <span className={cn('font-semibold', statusColor(response.status))}>
          {response.status} {response.statusText}
        </span>
        <span className="text-muted">{formatMs(response.timings.total)}</span>
        <span className="text-muted">{formatBytes(response.size)}</span>
        {response.truncated && <span className="text-warning">truncated</span>}
        {error && <span className="text-danger truncate">{error}</span>}
        <div className="flex-1" />
        <Segmented<View>
          value={view}
          onChange={setView}
          className="border-b-0"
          options={[
            { value: 'body', label: 'Body' },
            { value: 'headers', label: `Headers (${response.headers.length})` },
            { value: 'request', label: 'Request' },
          ]}
        />
      </div>
      <div className="flex-1 min-h-0 p-2">
        {view === 'body' && (
          <div className="flex flex-col h-full gap-1">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="truncate">{response.contentType ?? 'unknown content type'}</span>
              <div className="flex-1" />
              {language === 'json' && (
                <Button size="sm" variant="ghost" onClick={() => setPretty((p) => !p)}>
                  {pretty ? 'Raw' : 'Pretty'}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={() => navigator.clipboard.writeText(text).then(() => notify('Copied', 'success'))}
              >
                Copy
              </Button>
            </div>
            <div className="flex-1 min-h-0">
              <CodeEditor value={text} readOnly language={language} wrap={language !== 'json'} />
            </div>
          </div>
        )}
        {view === 'headers' && <HeaderTable headers={response.headers} />}
        {view === 'request' && (
          <div className="flex flex-col h-full gap-2 text-xs">
            <div className="font-mono break-all">
              <span className="font-semibold">{response.sent.method}</span> {response.sent.url}
            </div>
            <HeaderTable headers={response.sent.headers} />
            {response.sent.bodyPreview && (
              <div className="flex-1 min-h-[80px]">
                <CodeEditor value={response.sent.bodyPreview} readOnly language="text" wrap />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderTable({ headers }: { headers: [string, string][] }) {
  return (
    <div className="overflow-auto h-full text-xs font-mono">
      <table className="w-full">
        <tbody>
          {headers.map(([k, v], i) => (
            <tr key={`${k}-${i}`} className="border-b border-edge/60 align-top">
              <td className="py-1 pr-3 text-muted whitespace-nowrap">{k}</td>
              <td className="py-1 break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBody(response: ApiResponse | null, pretty: boolean): { text: string; language: CodeLanguage } {
  if (!response) return { text: '', language: 'text' };
  if (response.bodyEncoding === 'base64') {
    return { text: `Binary response (${formatBytes(response.size)}). Base64:\n${response.body.slice(0, 2000)}${response.body.length > 2000 ? '…' : ''}`, language: 'text' };
  }
  const ct = response.contentType ?? '';
  const looksJson = /json/i.test(ct) || /^\s*[[{]/.test(response.body);
  if (looksJson) {
    if (pretty) {
      try {
        return { text: JSON.stringify(JSON.parse(response.body), null, 2), language: 'json' };
      } catch {
        // fall through to raw
      }
    }
    return { text: response.body, language: 'json' };
  }
  if (/html/i.test(ct)) return { text: response.body, language: 'html' };
  if (/xml/i.test(ct)) return { text: response.body, language: 'xml' };
  return { text: response.body, language: 'text' };
}
