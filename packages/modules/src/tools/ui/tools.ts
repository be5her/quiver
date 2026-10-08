import type { CodeLanguage } from '@quiver/ui';

export interface ToolOption {
  key: string;
  label: string;
  type: 'select' | 'boolean' | 'number';
  choices?: { value: string; label: string }[];
  default: string | boolean | number;
}

export interface ToolSecondInput {
  /** Name of the field on `commandId`. */
  key: 'key';
  label: string;
  placeholder?: string;
  /** Runs instead of the tool's command while this input holds text. */
  commandId: string;
}

export interface ToolSummary {
  ok: boolean;
  text: string;
}

export interface ToolDescriptor {
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
  /** An optional second input under the first. */
  secondInput?: ToolSecondInput;
  /** A one-line verdict over the output, read from the command's result. */
  summary?: (result: Record<string, unknown>) => ToolSummary | null;
  /** Run on every keystroke instead of on demand. */
  live?: boolean;
}

export const TOOLS: ToolDescriptor[] = [
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
  {
    id: 'jwt',
    title: 'JWT',
    description: 'Decode a token, check its expiry, verify its signature.',
    commandId: 'tools.jwt.decode',
    inputKey: 'token',
    outputLanguage: 'json',
    placeholder: 'eyJhbGciOi...',
    secondInput: {
      key: 'key',
      label: 'Verify the signature with',
      placeholder: 'A shared secret (HS256/384/512), or a PEM public key, certificate, JWK or JWK set (RS, PS, ES, EdDSA)',
      commandId: 'tools.jwt.verify',
    },
    options: [{ key: 'base64Secret', label: 'Secret is base64', type: 'boolean', default: false }],
    summary: (result) =>
      typeof result['signatureValid'] === 'boolean'
        ? { ok: result['signatureValid'], text: `${result['signatureValid'] ? 'Signature verified' : 'Signature does not match'} (${result['algorithm']}, ${result['keyFormat']}${result['kid'] ? ` "${result['kid']}"` : ''})` }
        : null,
    live: true,
  },
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

/** The option values as the command takes them. */
export function coerce(values: Record<string, string | boolean | number>, options: ToolOption[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const opt of options) {
    const v = values[opt.key];
    if (opt.key === 'indent') out[opt.key] = Number(v);
    else out[opt.key] = v;
  }
  return out;
}
