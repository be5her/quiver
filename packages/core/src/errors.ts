export type QuiverErrorCode =
  | 'NO_WORKSPACE'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'MUTATION_BLOCKED'
  | 'REQUEST_FAILED'
  | 'UNRESOLVED_VARIABLES'
  /** The Teleport certificate is missing or expired; the UI offers "Log in again". */
  | 'TELEPORT_LOGIN_REQUIRED'
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
