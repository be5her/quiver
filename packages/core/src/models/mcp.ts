import { z } from 'zod';
import { newId, nowIso } from '../ids';
import { KeyValueSchema, RequestAuthSchema, keyValue, type KeyValue } from './api';

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/** An MCP server the inspector can connect to, saved with the project. */
export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string().default('Server'),
  transport: McpTransportSchema.default('stdio'),
  /** stdio: the executable, then its arguments. `{{variables}}` and `${ENV}` references are allowed. */
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  /** stdio: environment variables added on top of Quiver's own. */
  env: z.array(KeyValueSchema).default([]),
  /** stdio: working directory, relative to the project folder when not absolute; empty means the project folder. */
  cwd: z.string().default(''),
  /** http and sse: the endpoint URL. */
  url: z.string().default(''),
  headers: z.array(KeyValueSchema).default([]),
  auth: RequestAuthSchema.default({ type: 'none' }),
  /** http and sse: accept self-signed certificates. */
  insecure: z.boolean().default(false),
  autoConnect: z.boolean().default(false),
  logLimit: z.number().int().min(10).max(5000).default(500),
  /** Project config file the server was imported from, e.g. `.mcp.json`. */
  importedFrom: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/** Every field optional and without defaults, so a partial update only touches what it names. */
export const McpServerDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  transport: McpTransportSchema.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.array(KeyValueSchema).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.array(KeyValueSchema).optional(),
  auth: RequestAuthSchema.optional(),
  insecure: z.boolean().optional(),
  autoConnect: z.boolean().optional(),
  logLimit: z.number().int().min(10).max(5000).optional(),
  importedFrom: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type McpServerDraft = z.infer<typeof McpServerDraftSchema>;

export type McpStatus = 'disconnected' | 'connecting' | 'connected';

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpServerSummary extends McpServer {
  status: McpStatus;
  error: string | null;
  connectedAt: string | null;
  serverInfo: McpServerInfo | null;
  /** The server's capabilities as announced on initialize. */
  capabilities: Record<string, unknown> | null;
  instructions: string | null;
  protocolVersion: string | null;
  /** stdio: the child process id while connected. */
  pid: number | null;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  logCount: number;
}

export type McpLogDirection = 'out' | 'in' | 'system';
export type McpLogKind = 'request' | 'response' | 'error' | 'notification' | 'log' | 'stderr' | 'info' | 'open' | 'close';

/** One line of the traffic log: a JSON-RPC message, a stderr line, or a state change. */
export interface McpLogEntry {
  id: string;
  serverId: string;
  at: string;
  /** `out` is client to server, `in` is server to client. */
  direction: McpLogDirection;
  kind: McpLogKind;
  /** JSON-RPC method of a request or notification; for a response, the method of the request it answers. */
  method: string | null;
  requestId: string | number | null;
  /** Responses: time since the request went out. */
  durationMs: number | null;
  /** Responses: false for a JSON-RPC error or a tool result flagged `isError`. */
  ok: boolean | null;
  data: string;
  size: number;
  truncated: boolean;
}

// ---------- wire shapes (structural copies of the MCP types, so the renderer needs no SDK) ----------

export interface McpJsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  items?: McpJsonSchema | McpJsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  anyOf?: McpJsonSchema[];
  oneOf?: McpJsonSchema[];
  allOf?: McpJsonSchema[];
  additionalProperties?: boolean | McpJsonSchema;
  format?: string;
  [key: string]: unknown;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  annotations?: McpToolAnnotations;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: McpResourceContents }
  | { type: 'resource_link'; uri: string; name: string; description?: string; mimeType?: string };

export interface McpToolResult {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolCallOutcome {
  result: McpToolResult;
  durationMs: number;
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpContent;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpReadResourceResult {
  contents: McpResourceContents[];
}

export const MCP_LOGGING_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const;
export type McpLoggingLevel = (typeof MCP_LOGGING_LEVELS)[number];

// ---------- helpers ----------

export function newMcpServer(partial: Partial<McpServer> = {}): McpServer {
  const ts = nowIso();
  return McpServerSchema.parse({ id: newId(), createdAt: ts, updatedAt: ts, ...partial });
}

export function transportLabel(transport: McpTransport): string {
  return transport === 'stdio' ? 'CMD' : transport === 'sse' ? 'SSE' : 'HTTP';
}

/** One-line description for lists: the command line, or the transport plus host. */
export function describeMcpServer(server: Pick<McpServer, 'transport' | 'command' | 'args' | 'url'>): string {
  if (server.transport === 'stdio') return joinCommandLine(server.command, server.args) || 'no command';
  const host = server.url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] || server.url || 'no URL';
  return `${transportLabel(server.transport)} ${host}`;
}

/**
 * Split a command line into the executable and its arguments. Double quotes group and allow `\"` and `\\`,
 * single quotes group literally, and a backslash outside quotes is kept as is so Windows paths survive.
 */
export function splitCommandLine(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[i + 1];
        i++;
      } else if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        out.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) out.push(current);
  return out;
}

/** The inverse of `splitCommandLine`: quote what needs quoting. */
export function joinCommandLine(command: string, args: string[]): string {
  const quote = (t: string) => (t === '' ? '""' : /[\s"']/.test(t) ? `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : t);
  return [command ? quote(command) : '', ...args.map(quote)].join(' ').trim();
}

/** Expand `${NAME}` and `${NAME:-default}` from an environment, as Claude Code does for `.mcp.json`. */
export function expandEnvRefs(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    return whole;
  });
}

// ---------- project config files ----------

/** Files, relative to the project folder, that other tools use to declare MCP servers. */
export const MCP_CONFIG_FILES = ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json'] as const;

export interface McpConfigEntry {
  name: string;
  draft: McpServerDraft;
}

/** What `mcp.server.discover` reports for one project config file. */
export interface McpConfigFile {
  /** Path relative to the project folder. */
  file: string;
  servers: { name: string; transport: McpTransport; description: string; imported: boolean }[];
  error: string | null;
}

/** Tolerate the comments and trailing commas VS Code allows in its JSON files. */
function parseJsonLoose(text: string): unknown {
  const clean = text.replace(/^﻿/, '');
  try {
    return JSON.parse(clean);
  } catch {
    let out = '';
    let quote = false;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (quote) {
        out += ch;
        if (ch === '\\') out += clean[++i] ?? '';
        else if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') {
        quote = true;
        out += ch;
      } else if (ch === '/' && clean[i + 1] === '/') {
        while (i < clean.length && clean[i] !== '\n') i++;
        out += '\n';
      } else if (ch === '/' && clean[i + 1] === '*') {
        const end = clean.indexOf('*/', i + 2);
        i = end === -1 ? clean.length : end + 1;
      } else out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  }
}

function toRows(record: unknown): KeyValue[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.entries(record as Record<string, unknown>).map(([key, value]) => keyValue(key, value === undefined || value === null ? '' : String(value)));
}

/**
 * Read the servers of a `.mcp.json` (Claude Code, Cursor, Windsurf: `mcpServers`) or a VS Code
 * `mcp.json` (`servers`). A `type` decides the transport; otherwise a `url` means Streamable HTTP.
 */
export function parseMcpConfig(text: string): McpConfigEntry[] {
  const doc = parseJsonLoose(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') return [];
  const table = (doc.mcpServers ?? doc.servers) as Record<string, Record<string, unknown>> | undefined;
  if (!table || typeof table !== 'object') return [];
  const out: McpConfigEntry[] = [];
  for (const [name, raw] of Object.entries(table)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
    const url = typeof raw.url === 'string' ? raw.url : '';
    const command = typeof raw.command === 'string' ? raw.command : '';
    const transport: McpTransport = type === 'sse' ? 'sse' : type === 'http' || type === 'streamable-http' || type === 'streamablehttp' ? 'http' : type === 'stdio' ? 'stdio' : url && !command ? 'http' : 'stdio';
    const draft: McpServerDraft = { name, transport };
    if (transport === 'stdio') {
      draft.command = command;
      draft.args = Array.isArray(raw.args) ? raw.args.map(String) : [];
      draft.env = toRows(raw.env);
      if (typeof raw.cwd === 'string') draft.cwd = raw.cwd;
    } else {
      draft.url = url;
      draft.headers = toRows(raw.headers);
    }
    out.push({ name, draft });
  }
  return out;
}

// ---------- schemas and templates ----------

const SKELETON_DEPTH = 6;

/**
 * A JSON value that satisfies the shape of a tool's input schema: required properties with placeholder
 * values (defaults, examples or the first enum member when given), optional properties only when they
 * carry a default. The user fills in the rest.
 */
export function skeletonFromSchema(schema: McpJsonSchema | undefined, depth = 0): unknown {
  if (!schema || depth > SKELETON_DEPTH) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const options = schema.anyOf ?? schema.oneOf;
  if (options?.length) return skeletonFromSchema(options[0], depth + 1);
  if (schema.allOf?.length) {
    const merged: McpJsonSchema = { type: 'object', properties: {}, required: [] };
    for (const part of schema.allOf) {
      Object.assign(merged.properties!, part.properties ?? {});
      merged.required!.push(...(part.required ?? []));
    }
    return skeletonFromSchema(merged, depth + 1);
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'string':
      return schema.format === 'date-time' ? new Date(0).toISOString() : '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'null':
      return null;
    case 'object':
    case undefined: {
      if (type === undefined && !schema.properties) return null;
      const out: Record<string, unknown> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (required.has(key) || prop.default !== undefined) out[key] = skeletonFromSchema(prop, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

/** Human labels for the capability flags a server announced. */
export function capabilityLabels(capabilities: Record<string, unknown> | null): string[] {
  if (!capabilities) return [];
  const out: string[] = [];
  const has = (key: string) => capabilities[key] !== undefined && capabilities[key] !== null;
  const flag = (key: string, sub: string) => Boolean((capabilities[key] as Record<string, unknown> | undefined)?.[sub]);
  if (has('tools')) out.push(flag('tools', 'listChanged') ? 'tools (list changes)' : 'tools');
  if (has('resources')) {
    const extras = [flag('resources', 'subscribe') && 'subscribe', flag('resources', 'listChanged') && 'list changes'].filter(Boolean);
    out.push(extras.length ? `resources (${extras.join(', ')})` : 'resources');
  }
  if (has('prompts')) out.push(flag('prompts', 'listChanged') ? 'prompts (list changes)' : 'prompts');
  if (has('logging')) out.push('logging');
  if (has('completions')) out.push('completions');
  if (has('tasks')) out.push('tasks');
  if (has('experimental')) {
    const keys = Object.keys((capabilities.experimental as Record<string, unknown>) ?? {});
    out.push(keys.length ? `experimental: ${keys.join(', ')}` : 'experimental');
  }
  for (const key of Object.keys(capabilities)) {
    if (!['tools', 'resources', 'prompts', 'logging', 'completions', 'tasks', 'experimental'].includes(key)) out.push(key);
  }
  return out;
}

/** Variable names of an RFC 6570 URI template, in order of appearance. */
export function templateVariables(uriTemplate: string): string[] {
  const out: string[] = [];
  for (const match of uriTemplate.matchAll(/\{([+#./;?&]?)([^}]+)\}/g)) {
    for (const part of match[2].split(',')) {
      const name = part.replace(/[:*].*$/, '').trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** Expand the common RFC 6570 forms: `{x}`, `{+x}`, `{#x}`, `{/x}`, `{.x}`, `{?x,y}`, `{&x}`. */
export function expandUriTemplate(uriTemplate: string, values: Record<string, string>): string {
  return uriTemplate.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_whole, op: string, list: string) => {
    const names = list.split(',').map((p) => p.replace(/[:*].*$/, '').trim());
    const enc = (v: string) => (op === '+' || op === '#' ? encodeURI(v) : encodeURIComponent(v));
    const present = names.filter((n) => values[n] !== undefined && values[n] !== '');
    switch (op) {
      case '?':
      case '&':
        return present.length ? `${op}${present.map((n) => `${n}=${enc(values[n]!)}`).join('&')}` : '';
      case ';':
        return present.map((n) => `;${n}${values[n] ? `=${enc(values[n]!)}` : ''}`).join('');
      case '/':
      case '.':
        return present.map((n) => `${op}${enc(values[n]!)}`).join('');
      case '#':
        return present.length ? `#${present.map((n) => enc(values[n]!)).join(',')}` : '';
      default:
        return present.map((n) => enc(values[n]!)).join(',');
    }
  });
}

/** True when a content block or resource is text the UI can show directly. */
export function contentText(content: McpContent): string | null {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'resource':
      return content.resource.text ?? null;
    default:
      return null;
  }
}
