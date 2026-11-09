/**
 * Narrow `@file` discovery seam over DSH's mounted file-reference provider.
 *
 * DSH owns discovery: `ctx.fileReferences.list(agent, query, signal)` is the
 * only producer of candidates, and a concrete provider such as
 * `@deepseek-ai/dsh-file-reference-local` owns traversal, ranking, caching and
 * invalidation. This module never scans the filesystem, resolves a path,
 * reads/attaches file bytes, keeps a catalog or invents a fallback list. It
 * only:
 *
 * - recognizes a mounted provider by its public `list` method (resolved per
 *   call, so an HMR replacement never leaves a stale service object behind);
 * - forwards the exact Agent/query/caller signal to that method exactly once;
 * - validates the unknown return value against the public
 *   `FileReferenceCandidate` shape without reordering, truncating or filling
 *   defaults, and
 * - maps provider rejections and malformed results to coded, redacted adapter
 *   diagnostics.
 *
 * Selecting a candidate is ordinary prompt text. Nothing here reads file
 * content, creates an Agent, or schedules a model turn.
 *
 * @module dsh-tui/backend/native-file-references
 */
import { BackendError, asBackendError, backendError } from './errors.ts'
import type { FileReferenceCandidate } from './types.ts'

/** Structural view of the public `ctx.fileReferences` discovery service. */
export interface FileReferenceServiceLike {
  list(agent: unknown, query: string, signal: AbortSignal): Promise<unknown>
}

const QUERY_LABEL = 'the native file-reference query was cancelled'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Resolve one mounted file-reference provider from a live host read.
 *
 * A missing service, or one whose `list` is not a function, is not a provider:
 * callers must not advertise or attempt discovery in that case. The value is
 * never retained by this module; callers re-read the host on every query.
 *
 * @param value - the raw `ctx.get('fileReferences')` result.
 * @returns the provider when it implements the public discovery method.
 */
export function fileReferenceService(value: unknown): FileReferenceServiceLike | undefined {
  const service = record(value)
  if (service === undefined) return undefined
  try {
    if (typeof service.list !== 'function') return undefined
  } catch {
    // A hostile service object is not a mounted provider; capability reads
    // must stay total.
    return undefined
  }
  return service as unknown as FileReferenceServiceLike
}

/**
 * Validate one provider result against the public path-only candidate shape.
 *
 * The array order and length are preserved exactly: providers own ranking and
 * limits, so this seam never sorts, dedupes, truncates or pads candidates. Each
 * entry must carry a non-empty string `path` and `kind` exactly `file` or
 * `directory`; anything else is a malformed native result, not an empty list.
 * Only the two public fields are projected, so provider-private ranking fields
 * never leak into the UI contract.
 *
 * @param value - the provider's unknown resolved value.
 * @returns candidates in the provider's exact order.
 */
export function normalizeFileReferenceCandidates(value: unknown): readonly FileReferenceCandidate[] {
  if (!Array.isArray(value)) {
    throw backendError('RUNTIME_REQUEST_FAILED', 'the native file-reference provider returned no candidate array')
  }
  try {
    const candidates: FileReferenceCandidate[] = []
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw backendError('RUNTIME_REQUEST_FAILED', `the native file-reference provider returned a malformed candidate at index ${index}`)
      }
      const path = (entry as { path?: unknown }).path
      const kind = (entry as { kind?: unknown }).kind
      if (typeof path !== 'string' || path.length === 0) {
        throw backendError('RUNTIME_REQUEST_FAILED', `the native file-reference candidate at index ${index} has no non-empty path`)
      }
      if (kind !== 'file' && kind !== 'directory') {
        throw backendError('RUNTIME_REQUEST_FAILED', `the native file-reference candidate at index ${index} has no file/directory kind`)
      }
      candidates.push({ path, kind })
    }
    return candidates
  } catch (error) {
    // A hostile candidate object can throw from a getter; normalize that to the
    // same coded diagnostic instead of leaking an unclassified rejection.
    if (error instanceof BackendError) throw error
    throw backendError('RUNTIME_REQUEST_FAILED', 'the native file-reference provider returned unreadable candidates')
  }
}

/**
 * Map one provider rejection without inventing a classification.
 *
 * A coded native/adapter error keeps its exact instance and code so
 * cancellation and staleness survive the boundary; an uncoded failure becomes
 * one redacted `RUNTIME_REQUEST_FAILED` that names the seam. Caller-signal
 * cancellation is reported as `ABORTED` even when a provider ignores its
 * signal and rejects for another reason.
 *
 * @param error - the value the provider rejected with.
 * @param signal - the owned signal forwarded to the provider.
 * @returns the coded diagnostic to rethrow.
 */
function providerFailure(error: unknown, signal: AbortSignal): BackendError {
  if (signal.aborted) return backendError('ABORTED', QUERY_LABEL)
  const coded = asBackendError(error, 'RUNTIME_REQUEST_FAILED')
  if (coded.code !== 'RUNTIME_REQUEST_FAILED') return coded
  return backendError('RUNTIME_REQUEST_FAILED', 'the native file-reference provider failed: ' + coded.message)
}

/**
 * Run exactly one native discovery call and validate its result.
 *
 * The caller owns Agent identity, attachment staleness and the outer timeout;
 * this function owns only the provider call, cancellation mapping and shape
 * validation. It never invokes the provider more than once and never retries
 * with a different query.
 *
 * @param service - the provider resolved for this call.
 * @param agent - the exact current native Agent whose session cwd bounds discovery.
 * @param query - the path text after `@`, forwarded verbatim.
 * @param signal - owned cancellation forwarded to the provider.
 * @returns validated candidates in the provider's exact order.
 */
export async function listFileReferenceCandidates(
  service: FileReferenceServiceLike,
  agent: unknown,
  query: string,
  signal: AbortSignal,
): Promise<readonly FileReferenceCandidate[]> {
  if (signal.aborted) throw backendError('ABORTED', QUERY_LABEL)
  let raw: unknown
  try {
    raw = await service.list(agent, query, signal)
  } catch (error) {
    throw providerFailure(error, signal)
  }
  // A resolved call after cancellation is not a result the caller may use.
  if (signal.aborted) throw backendError('ABORTED', QUERY_LABEL)
  return normalizeFileReferenceCandidates(raw)
}