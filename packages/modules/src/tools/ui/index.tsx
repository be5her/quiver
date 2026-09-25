import { toErrorPayload } from '@quiver/core';
import {
  Button,
  CodeEditor,
  Checkbox,
  Select,
  defineModuleUI,
  invoke,
  selectScope,
  useAppStore,
  useTabsStore,
  type CodeLanguage,
  type TabProps,
} from '@quiver/ui';
import { Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface ToolOption {
  key: string;
  label: string;
  type: 'select' | 'boolean' | 'number';
  choices?: { value: string; label: string }[];
  default: string | boolean | number;
}

interface ToolDescriptor {
  id: string;
  title: string;
  description: string;
  commandId: string;
  /** Name of the input field on the command. Omit for tools without input. */
  inputKey?: 'text' | 'token' | 'value';
  inputLanguage?: CodeLanguage;
  outputLanguage?: CodeLanguage;
  placeholder?: string;
  options?: ToolOption[];
  /** Run on every keystroke instead of on demand. */
  live?: boolean;
}

const TOOLS: ToolDescriptor[] = [
  {
    id: 'json-format',
    title: 'JSON format',
    description: 'Pretty-print or minify JSON.',
    commandId: 'tools.json.format',
    inputKey: 'text',
    inputLanguage: 'json',
    outputLanguage: 'json',
    placeholder: '{"paste":"json here"}',
    options: [
      { key: 'indent', label: 'Indent', type: 'select', default: '2', choices: [{ value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }, { value: '0', label: 'Minified' }] },
      { key: 'sortKeys', label: 'Sort keys', type: 'boolean', default: false },
    ],
    live: true,
  },
  { id: 'jwt', title: 'JWT decode', description: 'Inspect a token and its expiry.', commandId: 'tools.jwt.decode', inputKey: 'token', outputLanguage: 'json', placeholder: 'eyJhbGciOi...', live: true },
  {
    id: 'base64-encode',
    title: 'Base64 encode',
    description: 'Text to base64.',
    commandId: 'tools.base64.encode',
    inputKey: 'text',
    options: [{ key: 'urlSafe', label: 'URL safe', type: 'boolean', default: false }],
    live: true,
  },
  { id: 'base64-decode', title: 'Base64 decode', description: 'Base64 to text.', commandId: 'tools.base64.decode', inputKey: 'text', live: true },
  {
    id: 'url-encode',
    title: 'URL encode',
    description: 'Percent-encode text.',
    commandId: 'tools.url.encode',
    inputKey: 'text',
    options: [{ key: 'component', label: 'Encode reserved chars', type: 'boolean', default: true }],
    live: true,
  },
  { id: 'url-decode', title: 'URL decode', description: 'Decode percent-encoded text.', commandId: 'tools.url.decode', inputKey: 'text', live: true },
  {
    id: 'hash',
    title: 'Hash',
    description: 'MD5, SHA-1, SHA-256, SHA-512.',
    commandId: 'tools.hash.digest',
    inputKey: 'text',
    options: [
      {
        key: 'algorithm',
        label: 'Algorithm',
        type: 'select',
        default: 'sha256',
        choices: [{ value: 'md5', label: 'MD5' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha256', label: 'SHA-256' }, { value: 'sha512', label: 'SHA-512' }],
      },
    ],
    live: true,
  },
  {
    id: 'uuid',
    title: 'UUID',
    description: 'Generate v4 UUIDs.',
    commandId: 'tools.uuid.generate',
    options: [
      { key: 'count', label: 'Count', type: 'number', default: 1 },
      { key: 'uppercase', label: 'Uppercase', type: 'boolean', default: false },
    ],
  },
  { id: 'timestamp', title: 'Timestamp', description: 'Convert between unix and ISO.', commandId: 'tools.timestamp.convert', inputKey: 'value', outputLanguage: 'json', placeholder: 'now, 1700000000, or 2026-01-01T00:00:00Z', live: true },
];

function ToolsSidebar() {
  const scope = useAppStore(selectScope);
  const openTab = useTabsStore((s) => s.openTab);
  return (
    <div className="py-1">
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => openTab(scope, { type: 'tools.tool', title: tool.title, data: { id: tool.id } }, { singletonKey: `tools.tool:${tool.id}` })}
          className="w-full text-left px-3 py-1.5 hover:bg-elevated"
        >
          <div className="text-sm text-fg">{tool.title}</div>
          <div className="text-[11px] text-muted">{tool.description}</div>
        </button>
      ))}
    </div>
  );
}

function ToolTab({ tab }: TabProps) {
  const tool = useMemo(() => TOOLS.find((t) => t.id === tab.data?.id), [tab.data?.id]);
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<Record<string, string | boolean | number>>(() =>
    Object.fromEntries((tool?.options ?? []).map((o) => [o.key, o.default])),
  );
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!tool) return;
    if (tool.inputKey && !input.trim()) {
      setOutput('');
      setError(null);
      return;
    }
    setRunning(true);
    try {
      const payload: Record<string, unknown> = { ...coerce(options, tool.options ?? []) };
      if (tool.inputKey) payload[tool.inputKey] = input;
      const result = await invoke<{ text?: string } | Record<string, unknown>>(tool.commandId, payload, null);
      setOutput(typeof result === 'object' && result && 'text' in result && typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2));
      setError(null);
    } catch (err) {
      setError(toErrorPayload(err).message);
    } finally {
      setRunning(false);
    }
  };

  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    if (!tool?.live) return;
    const t = setTimeout(() => void run(), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, optionsKey]);

  if (!tool) return <div className="p-4 text-sm text-muted">Unknown tool.</div>;
  const outputLanguage = tool.outputLanguage ?? (output.startsWith('{') || output.startsWith('[') ? 'json' : 'text');

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 px-3 h-10 border-b border-edge shrink-0 flex-wrap">
        <span className="text-sm font-medium">{tool.title}</span>
        {tool.options?.map((opt) => (
          <label key={opt.key} className="flex items-center gap-1.5 text-xs text-muted">
            {opt.type === 'boolean' ? (
              <>
                <Checkbox checked={Boolean(options[opt.key])} onChange={(e) => setOptions({ ...options, [opt.key]: e.target.checked })} />
                {opt.label}
              </>
            ) : opt.type === 'select' ? (
              <>
                {opt.label}
                <Select className="h-6 text-xs" value={String(options[opt.key])} onChange={(e) => setOptions({ ...options, [opt.key]: e.target.value })}>
                  {opt.choices?.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <>
                {opt.label}
                <input
                  type="number"
                  className="h-6 w-16 rounded border border-edge bg-surface px-1 text-xs text-fg"
                  value={Number(options[opt.key])}
                  onChange={(e) => setOptions({ ...options, [opt.key]: Number(e.target.value) })}
                />
              </>
            )}
          </label>
        ))}
        <div className="flex-1" />
        {!tool.live && (
          <Button variant="primary" size="sm" loading={running} onClick={() => void run()}>
            Run
          </Button>
        )}
      </div>
      <div className={`flex-1 min-h-0 grid ${tool.inputKey ? 'grid-cols-2' : 'grid-cols-1'} gap-2 p-2`}>
        {tool.inputKey && (
          <CodeEditor value={input} onChange={setInput} language={tool.inputLanguage ?? 'text'} placeholder={tool.placeholder} wrap />
        )}
        <div className="flex flex-col min-h-0 gap-1">
          {error && <div className="text-xs text-danger px-1">{error}</div>}
          <CodeEditor value={output} readOnly language={outputLanguage} placeholder="Output" wrap />
        </div>
      </div>
    </div>
  );
}

function coerce(values: Record<string, string | boolean | number>, options: ToolOption[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const opt of options) {
    const v = values[opt.key];
    if (opt.key === 'indent') out[opt.key] = Number(v);
    else out[opt.key] = v;
  }
  return out;
}

export const toolsModuleUI = defineModuleUI({
  id: 'tools',
  title: 'Tools',
  icon: Wrench,
  order: 90,
  availability: 'always',
  Sidebar: ToolsSidebar,
  tabs: { 'tools.tool': ToolTab },
  actions: TOOLS.map((tool) => ({
    id: `tools.open.${tool.id}`,
    title: `Tool: ${tool.title}`,
    group: 'Tools',
    description: tool.description,
    run: () => {
      const scope = selectScope(useAppStore.getState());
      useTabsStore.getState().openTab(scope, { type: 'tools.tool', title: tool.title, data: { id: tool.id } }, { singletonKey: `tools.tool:${tool.id}` });
    },
  })),
});
