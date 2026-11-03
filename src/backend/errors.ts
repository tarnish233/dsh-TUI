/**
 * Backend-side error taxonomy. Every rejection names a stable code so the UI
 * can distinguish "unsupported here" from "the runtime failed".
 *
 * @module dsh-pi-tui/backend/errors
 */
export type BackendErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_ARGUMENT'
  | 'DSH_NOT_FOUND'
  | 'DSH_VERSION_UNSUPPORTED'
  | 'PROFILE_UNSUPPORTED'
  | 'SPAWN_FAILED'
  | 'STARTUP_TIMEOUT'
  | 'STARTUP_FAILED'
  | 'PROTOCOL_ERROR'
  | 'REQUEST_TIMEOUT'
  | 'NOT_CONNECTED'
  | 'CLOSED'
  | 'RUNTIME_EXITED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'UNSUPPORTED_COMMAND'
  | 'STALE_DECISION'
  | 'STALE_SESSION'
  | 'MODELS_UNAVAILABLE'
  | 'UNKNOWN_MODEL'
  | 'RUNTIME_REQUEST_FAILED'

export class BackendError extends Error {
  readonly code: BackendErrorCode
  readonly detail?: string

  constructor(code: BackendErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'BackendError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export function backendError(code: BackendErrorCode, message: string, detail?: string): BackendError {
  return new BackendError(code, message, detail)
}

/** Convert any thrown value into a BackendError without leaking stack traces. */
export function asBackendError(error: unknown): BackendError {
  if (error instanceof BackendError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BackendError('RUNTIME_REQUEST_FAILED', message)
}