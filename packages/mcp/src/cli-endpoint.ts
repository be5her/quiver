import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CLI_TOKEN_HEADER, type ErrorPayload } from '@quiver/core';
import { z } from 'zod';
/** A command's input can carry a file's content; anything bigger is not a command line's. */
const MAX_BODY = 64 * 1024 * 1024;

const CliRequestSchema = z.object({
  command: z.string().min(1),
  input: z.unknown().optional(),
  /** A folder path or workspace id; workspace commands without one run in the workspace the app shows. */
  workspace: z.string().nullable().optional(),
});

export type CliRequest = z.infer<typeof CliRequestSchema>;
export type CliOutcome = { ok: true; result: unknown } | { ok: false; error: ErrorPayload };

/** What the host gives the endpoint: the token of this run and how to execute a command as caller `cli`. */
export interface CliEndpoint {
  token(): string;
  /** `signal` aborts when the command line stops waiting (Ctrl+C, --timeout), so a long command is cancelled too. */
  run(request: CliRequest, signal?: AbortSignal): Promise<CliOutcome>;
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function sameToken(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One CLI call: `POST /cli` with the token header and `{ command, input, workspace }`. The command runs as
 * caller `cli`, the user's own process, so it gets the user's rights and unmasked results; agent policies are
 * for `mcp` only. A request with an `Origin` header is refused before anything else, so a web page in a browser
 * on this machine cannot reach it even by guessing the token. The answer is 200 with the command's outcome, which
 * may be a failure; other statuses mean the call never ran.
 */
export async function handleCliRequest(req: IncomingMessage, res: ServerResponse, endpoint: CliEndpoint | undefined): Promise<void> {
  if (!endpoint) return reply(res, 404, { error: { code: 'NOT_FOUND', message: 'The command line endpoint is off' } });
  if (req.headers.origin !== undefined) return reply(res, 403, { error: { code: 'FORBIDDEN', message: 'Browser requests are refused' } });
  if (req.method !== 'POST') return reply(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Send POST requests' } }, { allow: 'POST' });
  if (!sameToken(req.headers[CLI_TOKEN_HEADER], endpoint.token())) return reply(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Wrong or missing CLI token' } });
  let raw: string | null;
  try {
    raw = await readBody(req);
  } catch {
    // The connection went away while the body was arriving; nobody is left to answer.
    return;
  }
  if (raw === null) return reply(res, 413, { error: { code: 'TOO_LARGE', message: 'The request is over 64 MB' } });
  let parsed: ReturnType<typeof CliRequestSchema.safeParse>;
  try {
    parsed = CliRequestSchema.safeParse(JSON.parse(raw));
  } catch {
    return reply(res, 400, { error: { code: 'INVALID_INPUT', message: 'The body is not JSON' } });
  }
  if (!parsed.success) return reply(res, 400, { error: { code: 'INVALID_INPUT', message: 'The body is { command, input, workspace }' } });
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort(new Error('The command line stopped waiting'));
  });
  let outcome: CliOutcome;
  try {
    outcome = await endpoint.run(parsed.data, stop.signal);
  } catch (err) {
    outcome = { ok: false, error: { code: 'INTERNAL', message: (err as Error).message } };
  }
  if (!res.destroyed) reply(res, 200, outcome);
}
