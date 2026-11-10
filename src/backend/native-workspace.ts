/**
 * Pure validation/projection of the native `ctx.workspaceChanges` read faces.
 *
 * `@deepseek-ai/dsh-workspace-changes` appends a log-only `workspace/changes`
 * event naming one top-level turn and keeps that turn's summary on the Host for
 * the live Session. A turn may be recorded more than once (`stopping` records
 * inside the turn, `end` records again once a later tool result changed the
 * turn's last tool-result seq), and DSH's own event contract states that the
 * latest event for one turn replaces earlier ones — so a turn is not a
 * one-record identity. The adapter only whitelists the native facts of the
 * exact event it read into the neutral DTOs: it never reads a file, resolves a
 * path, runs git, watches the tree or infers a diff.
 *
 * The summary is deliberately projected field by field:
 *
 * - `cwd` and `snapshot` never cross the DTO (host layout and git object ids);
 * - `turn`, counts and per-file counts must be real non-negative safe integers;
 * - `binary`/`oversized` are forwarded only as the literal `true`;
 * - a value without a usable `turn` is absent, never `files: []`.
 *
 * @module dsh-tui/backend/native-workspace
 */
import { nativeSeq } from './native-seq.ts'
import type { WorkspaceChangeFile, WorkspaceChangesSummary, WorkspaceFileDiff } from './types.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Whitelist one native `WorkspaceChangesSummary`.
 *
 * @param value - raw `ctx.workspaceChanges.summary(sessionId, seq)` value.
 * @returns the DTO, or undefined when the native value is absent or malformed.
 */
export function workspaceChangesSummaryOf(value: unknown): WorkspaceChangesSummary | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const turn = nativeSeq(item.turn)
  const total = nativeSeq(item.total)
  const added = nativeSeq(item.added)
  const deleted = nativeSeq(item.deleted)
  if (turn === undefined || total === undefined || added === undefined || deleted === undefined) return undefined
  if (!Array.isArray(item.files)) return undefined
  const files: WorkspaceChangeFile[] = []
  for (const raw of item.files) {
    const file = record(raw)
    if (file === undefined) return undefined
    const path = text(file.path)
    const display = text(file.display)
    const fileAdded = nativeSeq(file.added)
    const fileDeleted = nativeSeq(file.deleted)
    if (path === undefined || display === undefined || fileAdded === undefined || fileDeleted === undefined) return undefined
    if (file.binary !== undefined && file.binary !== true) return undefined
    if (file.oversized !== undefined && file.oversized !== true) return undefined
    files.push({
      path,
      display,
      added: fileAdded,
      deleted: fileDeleted,
      ...(file.binary === true ? { binary: true } : {}),
      ...(file.oversized === true ? { oversized: true } : {}),
    })
  }
  // `total` counts every changed file, including ones the native cap omitted.
  if (total < files.length) return undefined
  return { turn, files, total, added, deleted }
}

/** Validation outcome of one `ctx.workspaceChanges.diff` response. */
export type WorkspaceDiffRead =
  /** The Host holds no comparison (disposed Session, unknown seq/index, restart). */
  | { readonly kind: 'absent' }
  | { readonly kind: 'diff'; readonly diff: WorkspaceFileDiff }
  | { readonly kind: 'malformed'; readonly reason: string }

function malformed(reason: string): WorkspaceDiffRead {
  return { kind: 'malformed', reason }
}

type WorkspaceTextDiff = Extract<WorkspaceFileDiff, { readonly kind: 'text' }>
type WorkspaceDiffHunk = WorkspaceTextDiff['hunks'][number]

/**
 * Validate one native `WorkspaceFileDiff` tagged union.
 *
 * @param value - raw `ctx.workspaceChanges.diff(...)` result.
 * @returns the validated DTO, the native absence, or a bounded malformed reason.
 */
export function workspaceFileDiffOf(value: unknown): WorkspaceDiffRead {
  if (value === undefined) return { kind: 'absent' }
  const diff = record(value)
  if (diff === undefined) return malformed('the native comparison is not an object')
  const path = text(diff.path)
  const display = text(diff.display)
  if (path === undefined || display === undefined) return malformed('the native comparison carries no path/display')
  if (diff.kind === 'binary' || diff.kind === 'oversized') {
    return { kind: 'diff', diff: { kind: diff.kind, path, display } }
  }
  if (diff.kind !== 'text') return malformed('the native comparison has an unknown kind')
  if (typeof diff.before !== 'boolean' || typeof diff.after !== 'boolean' || typeof diff.coarse !== 'boolean') {
    return malformed('the native text comparison lost its before/after/coarse flags')
  }
  if (!Array.isArray(diff.hunks)) return malformed('the native text comparison carries no hunk array')
  const hunks: WorkspaceDiffHunk[] = []
  for (const raw of diff.hunks) {
    const hunk = record(raw)
    if (hunk === undefined) return malformed('a native hunk is not an object')
    const oldStart = nativeSeq(hunk.oldStart)
    const oldLines = nativeSeq(hunk.oldLines)
    const newStart = nativeSeq(hunk.newStart)
    const newLines = nativeSeq(hunk.newLines)
    if (oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined) {
      return malformed('a native hunk carries no valid line bounds')
    }
    if (!Array.isArray(hunk.lines)) return malformed('a native hunk carries no line array')
    const lines: string[] = []
    for (const line of hunk.lines) {
      if (typeof line !== 'string') return malformed('a native hunk line is not a string')
      lines.push(line)
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines })
  }
  return {
    kind: 'diff',
    diff: { kind: 'text', path, display, before: diff.before, after: diff.after, coarse: diff.coarse, hunks },
  }
}