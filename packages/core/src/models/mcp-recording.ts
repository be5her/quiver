import { nowIso } from '../ids';
import type { WorkspaceInfo } from '../types';

/** Who called Quiver's MCP server: the client's name and version from the MCP handshake, else what its User-Agent says. */
export interface McpAgent {
  name: string;
  version: string | null;
  userAgent: string | null;
}

export type McpRecordingState = 'idle' | 'recording' | 'paused' | 'ended';

/** One tool call an agent made to Quiver's own MCP server. */
export interface McpRecordedCall {
  id: string;
  at: string;
  agent: McpAgent;
  /** The workspace the call ran against; null when none was bound. */
  workspace: WorkspaceInfo | null;
  /** The tool name as the agent sent it, e.g. `db_query_run`. */
  tool: string;
  arguments: unknown;
  /** Null while the call is still running. */
  ok: boolean | null;
  /** What the agent got back: the tool's output, or the error. Null while the call is still running. */
  result: unknown;
  durationMs: number | null;
  /** Length of the arguments and the result as JSON. */
  size: number;
}

/** A call without its bodies, for lists. */
export interface McpRecordedCallSummary extends Omit<McpRecordedCall, 'arguments' | 'result'> {
  /** The start of the arguments as JSON. */
  preview: string;
}

export interface McpRecordingStatus {
  state: McpRecordingState;
  startedAt: string | null;
  endedAt: string | null;
  /** True when the recording ended itself because it reached its size limit. */
  limitReached: boolean;
  count: number;
  bytes: number;
  /** The file the ended recording was last saved to. */
  savedTo: string | null;
}

/** The file a recording is saved as. */
export interface McpRecordingFile {
  format: typeof MCP_RECORDING_FORMAT;
  version: 1;
  /** The Quiver version that recorded it. */
  quiver: string;
  startedAt: string | null;
  endedAt: string | null;
  calls: McpRecordedCall[];
}

export const MCP_RECORDING_FORMAT = 'quiver.mcp-recording';
/** A recording lives in memory, so it ends itself at whichever of these it reaches first. */
export const MCP_RECORDING_MAX_CALLS = 5000;
export const MCP_RECORDING_MAX_BYTES = 50 * 1024 * 1024;
const PREVIEW_LENGTH = 200;

export interface McpRecorderOptions {
  maxCalls?: number;
  maxBytes?: number;
  now?(): string;
  /** Called after every change: the state moved, or a call started or finished. */
  onChange?(status: McpRecordingStatus): void;
}

function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Records the tool calls that reach Quiver's MCP server between start and end, in memory only.
 * Calls that arrive while idle, paused or ended are not kept; a call that started while
 * recording is still completed when its result arrives later.
 */
export class McpRecorder {
  private state: McpRecordingState = 'idle';
  private startedAt: string | null = null;
  private endedAt: string | null = null;
  private limitReached = false;
  private savedTo: string | null = null;
  private bytes = 0;
  private seq = 0;
  private calls: McpRecordedCall[] = [];
  private previews = new Map<string, string>();
  private readonly maxCalls: number;
  private readonly maxBytes: number;
  private readonly now: () => string;

  constructor(private readonly options: McpRecorderOptions = {}) {
    this.maxCalls = options.maxCalls ?? MCP_RECORDING_MAX_CALLS;
    this.maxBytes = options.maxBytes ?? MCP_RECORDING_MAX_BYTES;
    this.now = options.now ?? nowIso;
  }

  status(): McpRecordingStatus {
    return {
      state: this.state,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      limitReached: this.limitReached,
      count: this.calls.length,
      bytes: this.bytes,
      savedTo: this.savedTo,
    };
  }

  /** Starts a new recording, dropping the previous one. */
  start(): McpRecordingStatus {
    this.reset();
    this.state = 'recording';
    this.startedAt = this.now();
    return this.changed();
  }

  pause(): McpRecordingStatus {
    if (this.state !== 'recording') return this.status();
    this.state = 'paused';
    return this.changed();
  }

  resume(): McpRecordingStatus {
    if (this.state !== 'paused') return this.status();
    this.state = 'recording';
    return this.changed();
  }

  end(): McpRecordingStatus {
    if (this.state !== 'recording' && this.state !== 'paused') return this.status();
    this.state = 'ended';
    this.endedAt = this.now();
    return this.changed();
  }

  /** Drops the recording and goes back to idle. */
  clear(): McpRecordingStatus {
    this.reset();
    return this.changed();
  }

  /** A call arrived. Returns its id to finish it with, or null when it is not being recorded. */
  begin(call: Pick<McpRecordedCall, 'agent' | 'workspace' | 'tool' | 'arguments'>): string | null {
    if (this.state !== 'recording') return null;
    const id = String(++this.seq);
    const json = jsonOf(call.arguments);
    this.calls.push({ id, at: this.now(), agent: call.agent, workspace: call.workspace, tool: call.tool, arguments: call.arguments, ok: null, result: null, durationMs: null, size: json.length });
    this.previews.set(id, json.slice(0, PREVIEW_LENGTH));
    this.bytes += json.length;
    this.enforceLimits();
    this.changed();
    return id;
  }

  /** The call answered (or failed). Unknown ids, e.g. from a recording dropped in the meantime, are ignored. */
  finish(id: string, outcome: { ok: boolean; result: unknown; durationMs: number }): void {
    const call = this.calls.find((c) => c.id === id);
    if (!call || call.ok !== null) return;
    const size = jsonOf(outcome.result).length;
    call.ok = outcome.ok;
    call.result = outcome.result ?? null;
    call.durationMs = outcome.durationMs;
    call.size += size;
    this.bytes += size;
    this.enforceLimits();
    this.changed();
  }

  list(): McpRecordedCallSummary[] {
    return this.calls.map(({ arguments: _arguments, result: _result, ...rest }) => ({ ...rest, preview: this.previews.get(rest.id) ?? '' }));
  }

  get(id: string): McpRecordedCall | undefined {
    return this.calls.find((c) => c.id === id);
  }

  /** The recording as the document that gets saved to a file. */
  export(quiver: string): McpRecordingFile {
    return { format: MCP_RECORDING_FORMAT, version: 1, quiver, startedAt: this.startedAt, endedAt: this.endedAt, calls: this.calls.map((c) => ({ ...c })) };
  }

  markSaved(file: string): McpRecordingStatus {
    this.savedTo = file;
    return this.changed();
  }

  private reset(): void {
    this.state = 'idle';
    this.startedAt = null;
    this.endedAt = null;
    this.limitReached = false;
    this.savedTo = null;
    this.bytes = 0;
    this.calls = [];
    this.previews.clear();
  }

  private enforceLimits(): void {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    if (this.calls.length < this.maxCalls && this.bytes < this.maxBytes) return;
    this.state = 'ended';
    this.endedAt = this.now();
    this.limitReached = true;
  }

  private changed(): McpRecordingStatus {
    const status = this.status();
    this.options.onChange?.(status);
    return status;
  }
}

/** Default file name for a saved recording, from its local start time: `quiver-mcp-recording-20260930-143205.json`. */
export function mcpRecordingFileName(startedAt: string | null): string {
  const d = startedAt ? new Date(startedAt) : new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `quiver-mcp-recording-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.json`;
}

/** Display name of an agent, e.g. `claude-code 2.1.0`. */
export function mcpAgentLabel(agent: McpAgent): string {
  return agent.version ? `${agent.name} ${agent.version}` : agent.name;
}
