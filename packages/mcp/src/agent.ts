import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { McpAgent } from '@quiver/core';

export const SESSION_HEADER = 'mcp-session-id';
const SESSION_PREFIX = 'quiver';
const MAX_NAME = 100;

/** A JSON-RPC message, as far as the HTTP layer looks into it. */
export interface RpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
  result?: unknown;
  error?: unknown;
}

export function rpcMessages(body: unknown): RpcMessage[] {
  return (Array.isArray(body) ? body : [body]).filter((m): m is RpcMessage => typeof m === 'object' && m !== null);
}

/**
 * The server keeps no sessions, so the session id itself carries who the client said it is:
 * `quiver.<base64url of [name, version]>.<random>`. Clients send it back with every later request.
 */
export function encodeAgentSession(agent: Pick<McpAgent, 'name' | 'version'>): string {
  const who = Buffer.from(JSON.stringify([agent.name.slice(0, MAX_NAME), agent.version?.slice(0, MAX_NAME) ?? null])).toString('base64url');
  return `${SESSION_PREFIX}.${who}.${randomUUID().replace(/-/g, '')}`;
}

export function decodeAgentSession(sessionId: string): Pick<McpAgent, 'name' | 'version'> | null {
  const [prefix, who] = sessionId.split('.');
  if (prefix !== SESSION_PREFIX || !who) return null;
  try {
    const [name, version] = JSON.parse(Buffer.from(who, 'base64url').toString('utf8')) as unknown[];
    if (typeof name !== 'string' || !name) return null;
    return { name, version: typeof version === 'string' ? version : null };
  } catch {
    return null;
  }
}

/** The first product of a User-Agent, e.g. `claude-code/2.1.0 (cli)` gives claude-code 2.1.0. */
export function agentFromUserAgent(userAgent: string | undefined): McpAgent {
  const [, name, version] = /^\s*([^\s/()]+)(?:\/(\S+))?/.exec(userAgent ?? '') ?? [];
  return { name: name ?? 'unknown', version: version ?? null, userAgent: userAgent?.trim() || null };
}

/**
 * Who is calling: the client info of an initialize request (which also gets a session id to hand out),
 * else the session id a client sends back, else the User-Agent.
 */
export function identifyAgent(headers: IncomingHttpHeaders, messages: RpcMessage[]): { agent: McpAgent; sessionId: string | null } {
  const fallback = agentFromUserAgent(headers['user-agent']);
  const info = messages.find((m) => m.method === 'initialize')?.params?.clientInfo;
  if (info && typeof info.name === 'string' && info.name) {
    const agent: McpAgent = { name: info.name, version: typeof info.version === 'string' ? info.version : null, userAgent: fallback.userAgent };
    return { agent, sessionId: encodeAgentSession(agent) };
  }
  const header = headers[SESSION_HEADER];
  const known = decodeAgentSession((Array.isArray(header) ? header[0] : header) ?? '');
  return { agent: known ? { ...known, userAgent: fallback.userAgent } : fallback, sessionId: null };
}

/**
 * What a tools/call response told the agent. Quiver's tools answer with one JSON text block,
 * which is given back parsed so a recording holds the value rather than a string of it.
 */
export function toolCallOutcome(response: RpcMessage): { ok: boolean; result: unknown } {
  if (response.error !== undefined) return { ok: false, result: response.error };
  const result = response.result as { content?: unknown; isError?: unknown } | null | undefined;
  const content = result?.content;
  const ok = result?.isError !== true;
  if (!Array.isArray(content)) return { ok, result: result ?? null };
  const only = content.length === 1 ? (content[0] as { type?: unknown; text?: unknown }) : null;
  if (only?.type !== 'text' || typeof only.text !== 'string') return { ok, result: content };
  try {
    return { ok, result: JSON.parse(only.text) };
  } catch {
    return { ok, result: only.text };
  }
}
