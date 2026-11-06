/**
 * Backend-side error taxonomy. Every rejection names a stable code so the UI
 * can distinguish "unsupported here" from "the runtime failed".
 *
 * @module dsh-tui/backend/errors
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
  | 'INVALID_ANSWER'
  /** An image exceeds an adapter-imposed transfer bound; recoverable, nothing durable changed. */
  | 'IMAGE_TOO_LARGE'
  /** The caller cancelled its own request (image read); nothing durable changed. */
  | 'ABORTED'
  | 'MODELS_UNAVAILABLE'
  | 'UNKNOWN_MODEL'
  | 'RUNTIME_REQUEST_FAILED'

/** Every stable adapter code, used to recognize coded foreign rejections. */
const BACKEND_ERROR_CODES: ReadonlySet<string> = new Set<BackendErrorCode>([
  'INVALID_OPTIONS',
  'INVALID_ARGUMENT',
  'DSH_NOT_FOUND',
  'DSH_VERSION_UNSUPPORTED',
  'PROFILE_UNSUPPORTED',
  'SPAWN_FAILED',
  'STARTUP_TIMEOUT',
  'STARTUP_FAILED',
  'PROTOCOL_ERROR',
  'REQUEST_TIMEOUT',
  'NOT_CONNECTED',
  'CLOSED',
  'RUNTIME_EXITED',
  'CAPABILITY_UNAVAILABLE',
  'UNSUPPORTED_COMMAND',
  'STALE_DECISION',
  'STALE_SESSION',
  'INVALID_ANSWER',
  'IMAGE_TOO_LARGE',
  'ABORTED',
  'MODELS_UNAVAILABLE',
  'UNKNOWN_MODEL',
  'RUNTIME_REQUEST_FAILED',
])

/**
 * Documented native error names that already mean one adapter code.
 *
 * `SessionAlreadyOwnedError` is DSH's single-writer refusal: another live
 * handle owns that session log, so this attachment cannot own it. An
 * `AbortError` is a cancellation, never a runtime failure.
 */
const NATIVE_ERROR_NAME_CODES: Readonly<Record<string, BackendErrorCode>> = {
  SessionAlreadyOwnedError: 'STALE_SESSION',
  AbortError: 'ABORTED',
}

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
  return new BackendError(code, redactDiagnostic(message), detail === undefined ? undefined : redactDiagnostic(detail))
}

/**
 * Read one stable adapter code from a thrown value, if it already carries one.
 *
 * Coded cancellations and stale checks keep their identity through every
 * boundary: an adapter `BackendError`, a foreign rejection whose `code` is one
 * of {@link BackendErrorCode}, or a documented native error name.
 *
 * @param error - any thrown value.
 * @returns the recognized code, or undefined when the value is unclassified.
 */
export function backendErrorCodeOf(error: unknown): BackendErrorCode | undefined {
  if (error instanceof BackendError) return error.code
  if (error === null || typeof error !== 'object') return undefined
  const item = error as { code?: unknown; name?: unknown }
  if (typeof item.code === 'string' && BACKEND_ERROR_CODES.has(item.code)) return item.code as BackendErrorCode
  if (typeof item.name === 'string' && Object.hasOwn(NATIVE_ERROR_NAME_CODES, item.name)) {
    return NATIVE_ERROR_NAME_CODES[item.name]
  }
  return undefined
}

/** Safe diagnostic for a rejection that carries no valid message field. */
const UNCLASSIFIED_FAILURE = 'the operation failed without a diagnostic message'

/**
 * Diagnostic text for any thrown value; never a serialization, never a stack.
 *
 * An arbitrary thrown object is deliberately not inspected beyond its own
 * scalar `message`/`name` fields: serializing it would dump enumerable `stack`,
 * `cause` and credential-shaped properties into a UI diagnostic. A value with
 * no usable message becomes one generic sentence instead.
 *
 * @param error - any thrown value.
 * @returns unredacted diagnostic text; callers redact it exactly once.
 */
function diagnosticText(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const item = error as { message?: unknown; name?: unknown }
    if (typeof item.message === 'string' && item.message.length > 0) return item.message
    if (typeof item.name === 'string' && item.name.length > 0) return item.name
    return UNCLASSIFIED_FAILURE
  }
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error)
  return UNCLASSIFIED_FAILURE
}

/**
 * Convert any thrown value into a sanitized {@link BackendError}.
 *
 * Message and detail always pass through {@link redactDiagnostic}; a stable
 * code already present on the value wins, otherwise `fallback` is used. Stack
 * traces and causes are never copied into the diagnostic.
 *
 * @param error - any thrown value, native or adapter produced.
 * @param fallback - code for a value with no stable code of its own.
 * @returns a BackendError whose diagnostics are safe to show.
 */
export function asBackendError(error: unknown, fallback: BackendErrorCode = 'RUNTIME_REQUEST_FAILED'): BackendError {
  const code = backendErrorCodeOf(error) ?? fallback
  if (error instanceof BackendError && error.code === code) {
    const message = redactDiagnostic(error.message)
    const detail = error.detail === undefined ? undefined : redactDiagnostic(error.detail)
    // Keep the exact instance when it already satisfies the guarantee.
    if (message === error.message && detail === error.detail) return error
    return new BackendError(code, message, detail)
  }
  const source = error !== null && typeof error === 'object' ? (error as { detail?: unknown }).detail : undefined
  const detail = typeof source === 'string' && source.length > 0 ? source : undefined
  return backendError(code, diagnosticText(error), detail)
}
/**
 * Redact credential-shaped values from adapter diagnostics.
 *
 * This is deliberately small and textual: adapter-origin error/warning text
 * must never echo an `Authorization` header, bearer token, API key or token
 * assignment. Native session events, tool output and presentation payloads are
 * never passed through this function.
 *
 * @param text - diagnostic text produced or forwarded by the adapter.
 * @returns the same text with recognized credential values replaced.
 */
export function redactDiagnostic(text: string): string {
  let result = text
  // Authorization headers, including a quoted JSON key and a value whose
  // quoting or escapes would defeat a `"[^"]*"` shortcut.
  result = result.replace(
    /(\bauthorization\b["']?\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;]+)/gi,
    '$1[redacted]',
  )
  result = result.replace(
    /\b(bearer)\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z0-9._~+/=-]+)/gi,
    '$1 [redacted]',
  )
  // Credential assignments: api_key=..., "apiKey": ..., token=..., secret=...
  result = result.replace(
    /(\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|client[_-]?secret)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)]+)/gi,
    '$1[redacted]',
  )
  // Common provider key shapes even without an assignment.
  result = result.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '[redacted]')
  return result
}
