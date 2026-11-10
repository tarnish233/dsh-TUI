/**
 * Width-safe rendering of one native workspace file diff.
 *
 * The DTO is DSH's already-computed native diff (`WorkspaceFileDiff`): hunks
 * carry real file coordinates, and `binary`/`oversized` files carry no hunks at
 * all. This module formats those facts only; it never reads a file, diffs two
 * blobs locally, runs git, watches the workspace or resolves a path/cwd.
 *
 * `coarse` is a native warning that line positions may be approximate, so it is
 * labelled as coarse instead of being presented as an exact unified diff.
 */
import type { WorkspaceFileDiff } from '../backend/types.ts'
import { fit, sanitize, wrap } from './text.ts'
import { t } from './theme.ts'
/** Native facts of a text diff, in a stable order. */
export function workspaceDiffFacts(diff: WorkspaceFileDiff): string[] {
  if (diff.kind !== 'text') return [diff.kind]
  const facts: string[] = ['text']
  if (!diff.before) facts.push('new file')
  if (!diff.after) facts.push('deleted file')
  if (diff.coarse) facts.push('coarse')
  return facts
}

function hunkHeader(hunk: Extract<WorkspaceFileDiff, { kind: 'text' }>['hunks'][number]): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

/** Native line vocabulary: a leading `+`/`-` is the line kind, never content. */
function lineKind(line: string): 'add' | 'del' | 'context' {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

function lineBody(line: string, kind: 'add' | 'del' | 'context'): string {
  if (kind === 'context') return line.startsWith(' ') ? line.slice(1) : line
  return line.slice(1)
}

function paintRow(kind: 'add' | 'del' | 'context', body: string): string {
  if (kind === 'add') return `${t.greenBright('+')}${t.text(body)}`
  if (kind === 'del') return `${t.redSoft('-')}${t.text(body)}`
  return `${t.subtle(' ')}${t.muted(body)}`
}

/**
 * Render the detail body for one native diff.
 *
 * Every returned line is fitted to `width`; long source rows wrap with the
 * diff marker only on the first physical row so the kind stays readable.
 * Binary/oversized/coarse states are stated explicitly, never rendered as an
 * empty diff that could be mistaken for "no changes".
 */
export function renderWorkspaceFileDiff(diff: WorkspaceFileDiff, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  if (diff.kind !== 'text') {
    const message = diff.kind === 'binary'
      ? 'Binary file — a native text diff is not available.'
      : 'File is too large for a native text diff.'
    return wrap(t.muted(message), safeWidth).map(line => fit(line, safeWidth))
  }
  const out: string[] = []
  if (diff.coarse) out.push(fit(t.yellow('Coarse text diff — line positions may be approximate.'), safeWidth))
  if (!diff.before) out.push(fit(t.subtle('new file'), safeWidth))
  if (!diff.after) out.push(fit(t.subtle('deleted file'), safeWidth))
  if (diff.hunks.length === 0) {
    out.push(fit(t.muted('The native diff contains no hunks.'), safeWidth))
    return out
  }
  for (const hunk of diff.hunks) {
    out.push(fit(t.subtle(hunkHeader(hunk)), safeWidth))
    for (const line of hunk.lines) {
      const kind = lineKind(line)
      const body = sanitize(lineBody(line, kind))
      const prefixWidth = 1
      const parts = body === '' ? [''] : wrap(body, Math.max(1, safeWidth - prefixWidth))
      parts.forEach((part, index) => {
        if (index === 0) out.push(fit(paintRow(kind, part), safeWidth))
        else out.push(fit(`${' '.repeat(prefixWidth)}${t.muted(part)}`, safeWidth))
      })
    }
  }
  return out
}

/** Narrow statement of a native file's diff availability (list/status use). */
export function workspaceDiffAvailability(diff: WorkspaceFileDiff | undefined): string {
  if (diff === undefined) return ''
  return workspaceDiffFacts(diff).join(' · ')
}

/** Indented plain-text rendering for compact summaries (tests/diagnostics). */
export function workspaceDiffSummary(diff: WorkspaceFileDiff): string {
  const facts = workspaceDiffFacts(diff)
  return `${diff.display} · ${facts.join(' · ')}`
}