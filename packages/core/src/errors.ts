export type QuiverErrorCode =
  | 'NO_WORKSPACE'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'MUTATION_BLOCKED'
  | 'REQUEST_FAILED'
  /** An HTTP request was stopped with api.request.cancel. */
  | 'REQUEST_CANCELLED'
  | 'UNRESOLVED_VARIABLES'
  /** The Teleport certificate is missing or expired; the UI offers "Log in again". */
  | 'TELEPORT_LOGIN_REQUIRED'
  /** A service reached through a web sign-in (Grafana) has no live session on this machine; the UI offers "Sign in". */
  | 'SIGN_IN_REQUIRED'
  /** A service reached with a per-machine credential (a Metabase API key) has none stored here; the UI opens the connection. */
  | 'AUTH_REQUIRED'
  /** The service refused the stored credential. */
  | 'AUTH_FAILED'
  /** A database statement was stopped with db.query.cancel. */
  | 'QUERY_CANCELLED'
  /** A row edit matched a number of rows other than one; the transaction was rolled back. */
  | 'CONFLICT'
  | 'INTERNAL';

export interface ErrorPayload {
  code: QuiverErrorCode;
  message: string;
  details?: unknown;
}

export class QuiverError extends Error {
  readonly code: QuiverErrorCode;
  readonly details?: unknown;

  constructor(code: QuiverErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'QuiverError';
    this.code = code;
    this.details = details;
  }

  toJSON(): ErrorPayload {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof QuiverError) return err.toJSON();
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message };
  return { code: 'INTERNAL', message: String(err) };
}
