/**
 * Width-safe diff rendering for tool cards.
 *
 * Layout ideas (unified/split columns, bars/classic indicators, a word-wrap
 * switch and an explicit collapsed row budget) are adapted from
 * `pi-tool-display` (MIT) through `pi-cc-extensions`
 * `extensions/renderer/tool/diff/` (see its ATTRIBUTION.md). This file is a
 * smaller implementation written for DSH's public projection: line diffing uses
 * the project's existing `diff` dependency, width/wrapping use public Pi TUI
 * helpers, and no ANSI or terminal state is parsed here.
 *
 * Copyright (c) MasuRii and pi-tool-display contributors. Used under the MIT
 * License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Honesty rule: a DSH FileDiff is a hunk without file coordinates. Rows carry
 * add/delete colors and indicators but never an absolute line-number gutter.
 */
import { diffLines } from 'diff'
import { DIFF_LCS_CHAR_LIMIT, type MetaDiff } from './tool-io.ts'
import { fit, sanitize, visibleWidth, wrap } from './text.ts'
import { t } from './theme.ts'

export type DiffViewMode = 'auto' | 'split' | 'unified'
export type DiffIndicatorMode = 'bars' | 'classic' | 'none'

export interface DiffRenderOptions {
  readonly viewMode: DiffViewMode
  readonly indicatorMode: DiffIndicatorMode
  readonly splitMinWidth: number
  readonly wordWrap: boolean
  /** Expanded cards render every row; collapsed cards use this budget. */
  readonly expanded: boolean
  readonly collapsedLines: number
  /**
   * Terminal/card width used for the split threshold when the rows themselves
   * render inside an indented section. Defaults to the render width.
   */
  readonly layoutWidth?: number
}

export interface DiffRenderResult {
  readonly lines: string[]
  readonly added: number
  readonly removed: number
  /** Rendered rows hidden by the collapsed budget (not a content fact). */
  readonly hidden: number
  readonly files: number
  /** At least one hunk was too large to turn into rows. */
  readonly oversized: boolean
}

interface DiffRow {
  readonly kind: 'add' | 'del' | 'context'
  readonly text: string
}

const MIN_SPLIT_WIDTH = 24
const SPLIT_SEPARATOR = ' │ '
const MIN_UNIFIED_WIDTH = 18

function buildDiffRows(diff: MetaDiff): DiffRow[] | undefined {
  const before = diff.oldText ?? ''
  const after = diff.newText
  if (before.length + after.length > DIFF_LCS_CHAR_LIMIT) return undefined
  const rows: DiffRow[] = []
  for (const change of diffLines(before, after)) {
    const lines = change.value.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      rows.push({
        kind: change.added === true ? 'add' : change.removed === true ? 'del' : 'context',
        text: sanitize(line),
      })
    }
  }
  return rows
}

function resolveMode(options: DiffRenderOptions, width: number): 'split' | 'unified' | 'summary' {
  if (width < 8) return 'summary'
  if (width < MIN_UNIFIED_WIDTH) return 'unified'
  // The split threshold is a layout preference, but the actual content width
  // must still fit two columns. A 50-column body never forces 24+24+3 > 50.
  const layoutWidth = Math.max(width, Math.floor(options.layoutWidth ?? width))
  const canSplit = width >= MIN_SPLIT_WIDTH * 2 + visibleWidth(SPLIT_SEPARATOR)
    && layoutWidth >= options.splitMinWidth
  if (options.viewMode === 'split') return canSplit ? 'split' : 'unified'
  if (options.viewMode === 'unified') return 'unified'
  return canSplit ? 'split' : 'unified'
}

function marker(kind: DiffRow['kind'], indicatorMode: DiffIndicatorMode, continuation: boolean): string {
  if (kind === 'context') return ' '
  if (continuation) return ' '
  switch (indicatorMode) {
    case 'bars': return '▌'
    case 'classic': return kind === 'add' ? '+' : '-'
    case 'none':
    default: return ' '
  }
}

function bodyLines(text: string, width: number, wordWrap: boolean): string[] {
  const safeWidth = Math.max(1, width)
  if (text === '') return ['']
  if (!wordWrap) return [fit(text, safeWidth)]
  return wrap(text, safeWidth)
}

function background(kind: DiffRow['kind'], text: string): string {
  if (kind === 'add') return t.diffAddBg(text)
  if (kind === 'del') return t.diffDelBg(text)
  return text
}

function markerStyle(kind: DiffRow['kind'], text: string): string {
  if (kind === 'add') return t.greenBright(text)
  if (kind === 'del') return t.redSoft(text)
  return t.subtle(text)
}

/** One unified row (possibly wrapped into several physical rows). */
function unifiedRows(row: DiffRow, width: number, options: DiffRenderOptions): string[] {
  const prefixWidth = 2
  const contentWidth = Math.max(1, width - prefixWidth)
  const parts = bodyLines(row.text, contentWidth, options.wordWrap)
  return parts.map((part, index) => {
    const continuation = index > 0
    const plainMarker = `${marker(row.kind, options.indicatorMode, continuation)} `
    const body = fit(part, contentWidth)
    if (row.kind === 'context') return `${t.subtle(plainMarker)}${t.muted(body)}`
    // Pad the code cell so the diff band reads as one row, then paint the
    // background once around both marker and body.
    const padding = ' '.repeat(Math.max(0, contentWidth - visibleWidth(body)))
    return background(row.kind, `${markerStyle(row.kind, plainMarker)}${t.text(body)}${padding}`)
  })
}

interface SplitRow {
  readonly left?: DiffRow
  readonly right?: DiffRow
}

function toSplitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let removed: DiffRow[] = []
  let added: DiffRow[] = []
  const flush = (): void => {
    const count = Math.max(removed.length, added.length)
    for (let index = 0; index < count; index += 1) {
      out.push({
        ...(removed[index] === undefined ? {} : { left: removed[index] }),
        ...(added[index] === undefined ? {} : { right: added[index] }),
      })
    }
    removed = []
    added = []
  }
  for (const row of rows) {
    if (row.kind === 'del') removed.push(row)
    else if (row.kind === 'add') added.push(row)
    else {
      flush()
      out.push({ left: row, right: row })
    }
  }
  flush()
  return out
}

/** One split cell rendered to exactly `width` visible columns. */
function splitCell(row: DiffRow | undefined, width: number, options: DiffRenderOptions): string[] {
  const safeWidth = Math.max(1, width)
  if (row === undefined) return [' '.repeat(safeWidth)]
  const prefixWidth = 2
  const contentWidth = Math.max(1, safeWidth - prefixWidth)
  const parts = bodyLines(row.text, contentWidth, options.wordWrap)
  return parts.map((part, index) => {
    const continuation = index > 0
    const plainMarker = `${marker(row.kind, options.indicatorMode, continuation)} `
    const body = fit(part, contentWidth)
    const padding = ' '.repeat(Math.max(0, safeWidth - visibleWidth(plainMarker) - visibleWidth(body)))
    if (row.kind === 'context') return `${t.subtle(plainMarker)}${t.muted(body)}${padding}`
    return background(row.kind, `${markerStyle(row.kind, plainMarker)}${t.text(body)}${padding}`)
  })
}

function splitWidths(width: number): { leftWidth: number; rightWidth: number } {
  const separatorWidth = visibleWidth(SPLIT_SEPARATOR)
  const leftWidth = Math.max(MIN_SPLIT_WIDTH, Math.floor((width - separatorWidth) / 2))
  return { leftWidth, rightWidth: Math.max(MIN_SPLIT_WIDTH, width - separatorWidth - leftWidth) }
}

/** Column labels are chrome; the collapsed budget never counts them. */
function splitHeaderRows(width: number): string[] {
  const { leftWidth, rightWidth } = splitWidths(width)
  // The rule must align with the body's centers: left + ' │ ' + right, so the
  // `┼` sits exactly under the `│` and the horizontal line is the full width.
  return [
    `${t.subtle('old'.padEnd(leftWidth))}${t.subtle(SPLIT_SEPARATOR)}${t.subtle('new'.padEnd(rightWidth))}`,
    t.subtle(`${'─'.repeat(leftWidth)}─┼─${'─'.repeat(rightWidth)}`),
  ]
}

function splitBodyRows(rows: readonly SplitRow[], width: number, options: DiffRenderOptions): string[] {
  const { leftWidth, rightWidth } = splitWidths(width)
  const out: string[] = []
  for (const row of rows) {
    const left = splitCell(row.left, leftWidth, options)
    const right = splitCell(row.right, rightWidth, options)
    const count = Math.max(left.length, right.length)
    for (let index = 0; index < count; index += 1) {
      out.push(`${left[index] ?? ' '.repeat(leftWidth)}${t.subtle(SPLIT_SEPARATOR)}${right[index] ?? ' '.repeat(rightWidth)}`)
    }
  }
  return out
}

function summaryRow(text: string, width: number): string {
  if (width === 0) return ''
  return fit(t.muted(text), width)
}

/**
 * Render the diff body. The caller owns card chrome, the applied/proposed
 * wording and the "N more lines" hint; this function only returns rows and
 * counts, and never invents file line numbers.
 */
export function renderDiffBlock(
  diffs: readonly MetaDiff[],
  width: number,
  options: DiffRenderOptions,
): DiffRenderResult {
  const safeWidth = Math.max(0, Math.floor(width))
  let added = 0
  let removed = 0
  let oversized = false
  const groups: Array<{ diff: MetaDiff; rows: DiffRow[] }> = []
  for (const diff of diffs) {
    const rows = buildDiffRows(diff)
    if (rows === undefined) {
      oversized = true
      continue
    }
    for (const row of rows) {
      if (row.kind === 'add') added += 1
      else if (row.kind === 'del') removed += 1
    }
    groups.push({ diff, rows })
  }
  if (safeWidth < 8) {
    return { lines: [summaryRow(`diff +${added} -${removed}`, safeWidth)], added, removed, hidden: 0, files: diffs.length, oversized }
  }
  const mode = resolveMode(options, safeWidth)
  const chrome: string[] = mode === 'split' ? splitHeaderRows(safeWidth) : []
  if (mode === 'summary') {
    return { lines: [...chrome, summaryRow(`diff +${added} -${removed}`, safeWidth)], added, removed, hidden: 0, files: diffs.length, oversized }
  }
  // Each group contributes optional file chrome and real diff rows. Only diff
  // rows consume the collapsed budget; the hidden count stays a content fact.
  const groupsRendered: Array<{ heading: string[]; rows: string[]; separator: string[] }> = []
  for (const [index, group] of groups.entries()) {
    const heading = diffs.length > 1 ? [summaryRow(`▸ ${group.diff.path}`, safeWidth)] : []
    const rows = mode === 'split'
      ? splitBodyRows(toSplitRows(group.rows), safeWidth, options)
      : group.rows.flatMap(row => unifiedRows(row, safeWidth, options))
    const separator = index < groups.length - 1 ? [''] : []
    groupsRendered.push({ heading, rows, separator })
  }
  const totalRows = groupsRendered.reduce((sum, group) => sum + group.rows.length, 0)
  const limit = options.expanded ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.collapsedLines))
  // A zero collapsed budget (the default for Write) is a counts-only summary:
  // neither diff rows nor split column chrome may leak into the folded card.
  if (!options.expanded && limit === 0) {
    return { lines: [], added, removed, hidden: totalRows, files: diffs.length, oversized }
  }
  let remaining = Math.min(limit, totalRows)
  let shownRows = 0
  const lines: string[] = [...chrome]
  for (const group of groupsRendered) {
    if (remaining <= 0 && lines.length > chrome.length) break
    lines.push(...group.heading)
    const shown = group.rows.slice(0, remaining)
    lines.push(...shown)
    remaining -= shown.length
    shownRows += shown.length
    if (shown.length < group.rows.length) break
    lines.push(...group.separator)
  }
  return {
    lines,
    added,
    removed,
    hidden: Math.max(0, totalRows - shownRows),
    files: diffs.length,
    oversized,
  }
}

/** Plain stats for a summary line, independent of rendering mode. */
export function diffStats(diffs: readonly MetaDiff[]): { added: number; removed: number; oversized: boolean } {
  let added = 0
  let removed = 0
  let oversized = false
  for (const diff of diffs) {
    const rows = buildDiffRows(diff)
    if (rows === undefined) {
      oversized = true
      continue
    }
    for (const row of rows) {
      if (row.kind === 'add') added += 1
      else if (row.kind === 'del') removed += 1
    }
  }
  return { added, removed, oversized }
}