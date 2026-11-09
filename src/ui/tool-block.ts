/**
 * One tool card: pi-cc-style folded summary → expanded Input / Output.
 *
 * Facts come only from the projected `ToolTranscriptItem` (see
 * `src/ui/tool-io.ts`). The card never reruns a tool, never reads a file and
 * never turns `proposed`/`running`/`unknown` into an executed result. Changes,
 * when DSH forwards a hunk, are rendered by `src/ui/tool-diff.ts`; a hunk has no
 * absolute file line numbers, so none are invented here.
 *
 * Expansion lives in `src/ui/tool-expansion.ts` (ephemeral, keyed by callId),
 * with an explicit group context for grouped cards: a grouped card asks the
 * group to collapse and never rewrites its own local override. Mouse handling
 * goes through the shared `HitboxRegistry`; this module parses no terminal
 * input and writes no stdout.
 */
import type { TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { ToolTranscriptItem, TranscriptItem } from '../state/transcript.ts'
import type { ItemBlock, TranscriptViewOptions } from './blocks.ts'
import { toolImageOccurrences } from './image-data.ts'
import { imageMarkerLine } from './image-marker.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { fit, sanitize, visibleWidth, wrap } from './text.ts'
import { bold, dim, t } from './theme.ts'
import { renderDiffBlock, diffStats } from './tool-diff.ts'
import { isToolExpanded, requestToolExpansion, toolExpansionKey } from './tool-expansion.ts'
import {
  formatToolDuration,
  getToolSummary,
  isTerminalTool,
  toolAppliedDiffs,
  toolInputText,
  toolOutputText,
  toolPresentationOf,
  toolProposedDiffs,
  type MetaDiff,
  type ToolPresentation,
} from './tool-io.ts'
import type { ToolGroupContext, ToolIoSection } from './tool-view.ts'

const DOT = '⏺'
const HOLLOW = '◌'
const ELBOW = '  ⎿  '
const INDENT = '     '
const INPUT_RAIL = '  │ '
const OUTPUT_INDENT = '    '

interface ToolCache {
  readonly width: number
  readonly key: string
  readonly lines: string[]
}

interface CappedBody {
  readonly rows: string[]
  readonly hidden: number
}

interface Projection {
  readonly presentation: ToolPresentation
  readonly applied: readonly MetaDiff[]
  readonly proposed: readonly MetaDiff[]
  readonly stats: { readonly added: number; readonly removed: number; readonly oversized: boolean }
  inputText?: string
  outputText?: string
}

function countLines(text: string): number {
  const trimmed = text.replace(/\n+$/, '')
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

function longerText(left: string, right: string): string {
  return right.length > left.length ? right : left
}

function plural(count: number, word: string): string {
  if (word === 'match') return `${count} ${count === 1 ? 'match' : 'matches'}`
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function styleInputRow(row: string): string {
  const match = /^([A-Za-z_][\w.-]*)(:\s*)(.*)$/.exec(row)
  if (match === null) return t.muted(row)
  return `${t.subtle((match[1] ?? '') + (match[2] ?? ''))}${t.muted(match[3] ?? '')}`
}

export class ToolBlock implements ItemBlock {
  readonly itemId: string
  readonly kind = 'tool' as const
  version: number
  private readonly flags: TranscriptViewOptions
  private item: ToolTranscriptItem
  private cwd = ''
  private group: ToolGroupContext | undefined
  private hovered: string | undefined
  private cache: ToolCache | undefined
  private pendingBoxes: MouseHitbox[] = []
  private lastBoxes: MouseHitbox[] = []
  private readonly registry = new HitboxRegistry()
  private lastWidth = 1
  private projectionCache: { readonly version: number; readonly value: Projection } | undefined

  constructor(item: ToolTranscriptItem, flags: TranscriptViewOptions) {
    this.itemId = item.id
    this.version = item.version
    this.item = item
    this.flags = flags
  }

  update(item: TranscriptItem): void {
    if (item.kind !== 'tool' || item.version === this.version) return
    this.item = item
    this.version = item.version
    this.invalidate()
  }

  /** The transcript parent may set the workspace cwd used for compact paths. */
  setCwd(cwd: string): void {
    if (cwd === this.cwd) return
    this.cwd = cwd
    this.invalidate()
  }

  /**
   * Grouped cards delegate the disclosure to the group. Local overrides in
   * `tool-expansion.ts` are deliberately untouched: leaving a group restores
   * the user's own per-call expansion state.
   */
  setToolGroupContext(context: ToolGroupContext | undefined): void {
    if (this.group?.key === context?.key) {
      this.group = context
      return
    }
    this.group = context
    this.invalidate()
  }

  /**
   * One lightweight projection per item version: presentation, applied and
   * proposed hunks and their stats. `canExpand`, the summary and the expanded
   * body share it instead of re-running the same diff projection three times.
   */
  private projection(): Projection {
    if (this.projectionCache?.version === this.version) return this.projectionCache.value
    const presentation = toolPresentationOf(this.item)
    const applied = toolAppliedDiffs(this.item)
    const proposed = toolProposedDiffs(this.item)
    const value: Projection = {
      presentation,
      applied,
      proposed,
      stats: diffStats(applied),
    }
    this.projectionCache = { version: this.version, value }
    return value
  }

  private inputText(): string {
    const projection = this.projection()
    if (projection.inputText === undefined) projection.inputText = toolInputText(this.item)
    return projection.inputText
  }

  private outputText(): string {
    const projection = this.projection()
    // The card renders real refs as clickable markers below, so the textual
    // body omits the duplicate reference paragraph. Copy still gets the full
    // source metadata through `toolCopyText`.
    if (projection.outputText === undefined) projection.outputText = toolOutputText(this.item, { imageRefs: 'omit' })
    return projection.outputText
  }

  get expanded(): boolean {
    if (this.group !== undefined) return this.group.isExpanded()
    return isToolExpanded(toolExpansionKey(this.item.callId), this.flags.expandTools)
  }

  /** True when this card carries a local override over the global expand flag. */
  private get overridden(): boolean {
    return isToolExpanded(toolExpansionKey(this.item.callId), this.flags.expandTools) !== this.flags.expandTools
  }

  private get fullscreen(): boolean {
    return this.flags.screen === 'fullscreen'
  }

  private liveDurationMs(): number | undefined {
    if (!isTerminalTool(this.item, this.projection().presentation)) return undefined
    if (this.item.status === 'done' || this.item.status === 'error') return this.item.durationMs
    if (this.item.startedAt === undefined) return this.item.durationMs
    const now = (this.flags.now ?? Date.now)()
    return Math.max(0, now - this.item.startedAt)
  }

  private durationText(): string {
    const ms = this.liveDurationMs()
    return ms === undefined ? '' : formatToolDuration(ms)
  }

  private requestRender(): void {
    this.flags.onRenderRequest?.()
  }

  private toggleExpansion(): void {
    if (this.group !== undefined) {
      // A child never opens its own disclosure inside a group; a click on the
      // expanded body/title collapses the group through its context.
      if (this.group.isExpanded()) this.group.collapse()
      return
    }
    requestToolExpansion(this.flags, toolExpansionKey(this.item.callId), !this.expanded)
    this.invalidate()
    this.requestRender()
  }

  private openDetails(section: ToolIoSection): void {
    this.flags.onToolDetails?.({ callId: this.item.callId, section })
  }

  private hoverEvent(id: string, entering: boolean): void {
    const next = entering ? id : this.hovered === id ? undefined : this.hovered
    if (next === this.hovered) return
    this.hovered = next
    this.requestRender()
  }

  private titleBox(row: number): MouseHitbox {
    const id = `${toolExpansionKey(this.item.callId)}:title`
    return {
      id,
      startRow: row,
      endRow: row,
      onClick: () => { this.toggleExpansion() },
      onHover: entering => { this.hoverEvent(id, entering) },
    }
  }

  private resultBox(row: number): MouseHitbox | undefined {
    if (!this.canExpand()) return undefined
    const id = `${toolExpansionKey(this.item.callId)}:result`
    return {
      id,
      startRow: row,
      endRow: row,
      onClick: () => { this.toggleExpansion() },
      onHover: entering => { this.hoverEvent(id, entering) },
    }
  }

  private detailsBox(row: number, section: ToolIoSection): MouseHitbox {
    const id = `${toolExpansionKey(this.item.callId)}:${section}:more`
    return {
      id,
      startRow: row,
      endRow: row,
      claimPress: true,
      onClick: () => { this.openDetails(section) },
      onHover: entering => { this.hoverEvent(id, entering) },
    }
  }

  /**
   * One compact marker row per real tool-result image, in declared order.
   * Bytes are never read here; a click only forwards the occurrence key.
   */
  private pushImageMarkers(lines: string[], boxes: MouseHitbox[], width: number): void {
    const occurrences = toolImageOccurrences(this.item)
    if (occurrences.length === 0) return
    const contentWidth = Math.max(1, width - OUTPUT_INDENT.length)
    const interactive = typeof this.flags.onImageDetails === 'function'
    for (const occurrence of occurrences) {
      const boxId = `${toolExpansionKey(this.item.callId)}:image:${occurrence.key}`
      const line = imageMarkerLine({
        number: occurrence.ordinal,
        attachment: occurrence.attachment,
        key: occurrence.key,
        interactive,
        fullscreen: this.fullscreen,
        ...(this.flags.imageDetailsHint === undefined ? {} : { hint: this.flags.imageDetailsHint }),
        ...(this.hovered === boxId ? { hovered: true } : {}),
      }, contentWidth)
      lines.push(`${t.subtle(OUTPUT_INDENT)}${line}`)
      if (!interactive) continue
      boxes.push({
        id: boxId,
        startRow: lines.length - 1,
        endRow: lines.length - 1,
        claimPress: true,
        onClick: () => { this.flags.onImageDetails?.({ key: occurrence.key }) },
        onHover: entering => { this.hoverEvent(boxId, entering) },
      })
    }
  }

  private bodyBox(startRow: number, endRow: number): MouseHitbox | undefined {
    if (endRow < startRow) return undefined
    return {
      id: `${toolExpansionKey(this.item.callId)}:body`,
      startRow,
      endRow,
      claimPress: false,
      onClick: () => { this.toggleExpansion() },
    }
  }

  private hintText(kind: 'expand' | 'collapse' | 'details'): string {
    if (kind === 'details') {
      if (this.fullscreen) return 'click to show details'
      const key = this.flags.hints?.toolsDetails?.trim() ?? ''
      return key === '' ? '' : `${key} to inspect tools`
    }
    if (kind === 'expand') {
      if (this.fullscreen) return 'click to expand'
      const key = this.flags.hints?.expand?.trim() ?? ''
      return key === '' ? '' : `${key} to expand`
    }
    if (this.fullscreen) return 'click to collapse'
    if (this.overridden) return ''
    const key = this.flags.hints?.expand?.trim() ?? ''
    return key === '' ? '' : `${key} to collapse`
  }

  private styledHint(kind: 'expand' | 'collapse' | 'details', hoverId: string): string {
    const text = this.hintText(kind)
    if (text === '') return ''
    return `${t.subtle(' · ')}${this.hovered === hoverId ? t.accent(text) : t.subtle(text)}`
  }

  /**
   * `⏺ Bash npm test · ctrl+o to collapse` — one display name, one real space,
   * then the native title/argument payload.
   *
   * The header never re-splits `summary.text`: the label and its payload arrive
   * as separate fields, so a native title that repeats the tool name in another
   * case (`Read image /Users/x.png`) cannot print the name twice and cannot glue
   * `Read ImageRead image …` together. The separator is a plain space and the
   * whole row is width-fitted by `render`, so wide CJK/emoji or ANSI-clean
   * titles keep their exact wording without any hardcoded offset.
   */
  private summaryLine(): string {
    const summary = getToolSummary(this.item, this.cwd, this.flags.toolLabelClip ?? 0)
    const dot = this.item.status === 'done'
      ? t.green(DOT)
      : this.item.status === 'error' ? t.red(DOT) : t.muted(this.item.status === 'proposed' || this.item.status === 'unknown' ? HOLLOW : DOT)
    const body = summary.detail === '' ? '' : ` ${t.muted(summary.detail)}`
    const hint = this.expanded ? this.styledHint('collapse', `${toolExpansionKey(this.item.callId)}:title`) : ''
    return `${dot} ${bold(t.text(summary.label))}${body}${hint}`
  }

  private canExpand(): boolean {
    if (this.item.status === 'proposed' || this.item.status === 'running' || this.item.status === 'unknown') return true
    const projection = this.projection()
    // Diff cards are already expandable; do not run the textual diff projection
    // just to answer this question.
    if (projection.applied.length > 0 || projection.proposed.length > 0) return true
    if (this.inputText().trim() !== '') return true
    if (this.item.resultImages > 0) return true
    return this.outputText().trim() !== ''
  }

  /** Applied vs proposed summary; never a success claim for error/unknown. */
  private diffSummary(kind: 'applied' | 'proposed'): string {
    const projection = this.projection()
    const diffs = kind === 'proposed' ? projection.proposed : projection.applied
    const paths = [...new Set(diffs.map(diff => this.displayPath(diff.path)))]
    const list = paths.slice(0, 3).join(', ')
    const more = paths.length > 3 ? ` (+${paths.length - 3} more)` : ''
    if (kind === 'proposed') {
      if (paths.length === 0) return 'Proposed · the model requested this call; DSH has not run it'
      return `Proposed change for ${list}${more} · not applied yet`
    }
    if (paths.length === 0) return 'No applied file changes observed'
    const stats = projection.stats
    if (stats.oversized) {
      // A huge hunk is still a real change. Never degrade to "no file changes"
      // merely because exact additions/removals were too large to compute.
      return `Changes present for ${list}${more} · hunk too large to count precisely`
    }
    if (stats.added + stats.removed === 0) return `No applied line changes for ${list}${more}`
    const created = diffs.length > 0 && diffs.every(diff => diff.oldText === null)
    const verb = this.item.name.toLowerCase() === 'write' && created ? 'Created' : 'Updated'
    if (paths.length === 1) return `${verb} ${paths[0]} with ${plural(stats.added, 'addition')} and ${plural(stats.removed, 'removal')}`
    return `${verb} ${plural(paths.length, 'file')} with ${plural(stats.added, 'addition')} and ${plural(stats.removed, 'removal')}`
  }

  private displayPath(path: string): string {
    if (this.cwd === '' || !path.startsWith('/')) return path
    const base = this.cwd.replace(/\/+$/, '')
    if (path === base) return '.'
    return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
  }

  private errorText(): string {
    const fallback = this.item.resultText.trim() !== '' ? firstLine(this.item.resultText) : ''
    return this.item.error?.reason
      ?? this.item.error?.code
      ?? (fallback !== '' ? fallback : 'Tool failed')
  }

  /** One-line folded result text (counts/summary, not a preview). */
  private collapsedSummary(): { text: string; error: boolean } {
    const projection = this.projection()
    const result = projection.presentation.result
    if (this.item.status === 'proposed') {
      return { text: this.diffSummary('proposed'), error: false }
    }
    if (this.item.status === 'running') return { text: 'Running…', error: false }
    if (this.item.status === 'unknown') {
      return { text: 'No result observed (turn ended or connection closed before a tool/result)', error: false }
    }
    if (this.item.status === 'error' || this.item.resultIsError) {
      return { text: this.errorText(), error: true }
    }
    if (projection.applied.length > 0) return { text: this.diffSummary('applied'), error: false }
    if (projection.proposed.length > 0) {
      return { text: 'No applied file changes observed · proposal not applied', error: false }
    }
    if (result?.card === 'terminal') {
      const lines = countLines(longerText(result.output ?? '', this.item.resultText))
      return { text: lines === 0 ? 'Done' : `${plural(lines, 'line')} returned`, error: false }
    }
    if (result?.card === 'read' && result.read !== undefined) {
      const read = result.read
      return { text: `${plural(read.lines.length, 'line')} loaded`, error: false }
    }
    if (result?.card === 'search' && result.search !== undefined) {
      const search = result.search
      const capped = search.truncated ? (search.total === undefined ? ' (truncated)' : ` (capped at ${search.total})`) : ''
      if (search.paths.length > 0) return { text: `${plural(search.paths.length, 'path')}${capped}`, error: false }
      const total = search.files.reduce((sum, file) => sum + file.matches.length, 0)
      return { text: `${plural(total, 'match')} in ${plural(search.files.length, 'file')}${capped}`, error: false }
    }
    if (result?.card === 'web' && result.web !== undefined) {
      const web = result.web
      if (web.kind === 'fetch') {
        return { text: `${web.url === undefined || web.url === '' ? 'Fetch' : web.url}${web.statusCode === undefined ? '' : ` · HTTP ${web.statusCode}`}${web.truncated ? ' · truncated' : ''}`, error: false }
      }
      return { text: `${plural(web.sources.length, 'source')}${web.truncated ? ' (capped)' : ''}`, error: false }
    }
    if (this.item.resultImages > 0 && this.item.resultText.trim() === '') {
      return { text: `${plural(this.item.resultImages, 'image')} returned`, error: false }
    }
    const text = result?.card === 'generic'
      ? longerText(result.contentText, this.item.resultText)
      : this.item.resultText
    const lines = countLines(text)
    return { text: lines === 0 ? 'Done' : `${plural(lines, 'line')} returned`, error: false }
  }

  private collapseBody(text: string, width: number, limit: number, section: ToolIoSection): CappedBody {
    const source = sanitize(text).replace(/\s+$/, '')
    if (source === '') return { rows: [], hidden: 0 }
    const safeWidth = Math.max(1, width)
    const rows: string[] = []
    for (const line of source.split('\n')) {
      if (line === '') {
        rows.push(section === 'input' ? styleInputRow('') : '')
        continue
      }
      const parts = wrap(line, safeWidth)
      for (const part of parts.length === 0 ? [''] : parts) {
        rows.push(section === 'input' ? styleInputRow(part) : part)
      }
    }
    const bounded = Math.max(1, Math.floor(limit))
    return { rows: rows.slice(0, bounded), hidden: Math.max(0, rows.length - bounded) }
  }

  private pushSection(
    lines: string[],
    boxes: MouseHitbox[],
    header: string,
    text: string,
    width: number,
    limit: number,
    section: ToolIoSection,
    style: (row: string) => string,
  ): void {
    const bodyWidth = Math.max(1, width - (section === 'input' ? INPUT_RAIL.length : OUTPUT_INDENT.length))
    const prefix = section === 'input' ? INPUT_RAIL : OUTPUT_INDENT
    const capped = this.collapseBody(text, bodyWidth, limit, section)
    if (capped.rows.length === 0) {
      lines.push(`${prefix}${t.subtle(section === 'input' ? '(empty)' : '(No output)')}`)
    } else {
      for (const row of capped.rows) lines.push(`${t.subtle(prefix)}${style(row)}`)
    }
    if (capped.hidden > 0) {
      const affordance = this.hintText('details')
      const label = `… ${capped.hidden} more ${capped.hidden === 1 ? 'line' : 'lines'}`
      lines.push(`${prefix}${t.subtle(label)}${affordance === '' ? '' : t.subtle(' · ') + (this.hovered === `${toolExpansionKey(this.item.callId)}:${section}:more` ? t.accent(affordance) : t.subtle(affordance))}`)
      boxes.push(this.detailsBox(lines.length - 1, section))
    }
  }

  private pushDiff(
    lines: string[],
    width: number,
    expanded: boolean,
    error: boolean,
  ): void {
    const diffs = this.projection().applied
    if (this.item.status !== 'done' || error || diffs.length === 0) return
    const collapsedLines = this.item.name.toLowerCase() === 'write'
      ? this.flags.writeDiffCollapsedLines ?? 0
      : this.flags.editDiffCollapsedLines ?? 24
    const indent = expanded ? OUTPUT_INDENT : INDENT
    const contentWidth = Math.max(1, width - indent.length)
    const rendered = renderDiffBlock(diffs, contentWidth, {
      viewMode: this.flags.diffViewMode ?? 'auto',
      indicatorMode: this.flags.diffIndicatorMode ?? 'bars',
      splitMinWidth: this.flags.diffSplitMinWidth ?? 120,
      wordWrap: this.flags.diffWordWrap ?? true,
      expanded,
      collapsedLines,
      layoutWidth: width,
    })
    for (const row of rendered.lines) lines.push(`${t.subtle(indent)}${row}`)
    if (rendered.oversized) lines.push(`${indent}${t.subtle('(diff too large to display)')}`)
    if (!expanded && rendered.hidden > 0 && collapsedLines > 0) {
      const hint = this.hintText('expand')
      lines.push(`${indent}${t.subtle(`… ${rendered.hidden} more ${rendered.hidden === 1 ? 'line' : 'lines'}`)}${hint === '' ? '' : t.subtle(' · ') + (this.hovered === `${toolExpansionKey(this.item.callId)}:result` ? t.accent(hint) : t.subtle(hint))}`)
    }
  }

  private build(width: number): string[] {
    this.lastWidth = width
    const lines: string[] = []
    const boxes: MouseHitbox[] = []
    const projection = this.projection()
    const presentation = projection.presentation
    const call = presentation.call
    const expanded = this.expanded
    const key = toolExpansionKey(this.item.callId)
    const titleRow = 0
    lines.push(this.summaryLine())
    boxes.push(this.titleBox(titleRow))

    let elbowUsed = false
    const bodyRow = (content: string): string => {
      const prefix = elbowUsed ? INDENT : ELBOW
      elbowUsed = true
      return `${prefix}${content}`
    }

    if (call?.description !== undefined && call.description.trim() !== '') {
      lines.push(bodyRow(dim(t.muted(cut(call.description, 400)))))
    }

    if (expanded) {
      const inputText = this.inputText()
      const result = presentation.result
      const applied = projection.applied
      const proposed = projection.proposed
      if (inputText.trim() !== '') {
        lines.push(`${t.subtle('  ├ ')}${bold(t.accent('Input'))}`)
        this.pushSection(lines, boxes, 'Input', inputText, width, this.flags.expandedInputMaxLines ?? 5, 'input', row => row)
        lines.push(`${t.subtle('  │')}`)
      }
      lines.push(`${t.subtle('  └ ')}${bold(t.accent('Output'))}`)
      if (this.item.status === 'proposed') {
        lines.push(`${OUTPUT_INDENT}${t.subtle('Proposed · not run: the model requested this call and DSH has not executed it')}`)
      } else if (this.item.status === 'running') {
        const duration = this.durationText()
        lines.push(`${OUTPUT_INDENT}${t.subtle(`No result yet · running${duration === '' ? '' : ` · ${duration}`}`)}`)
      } else if (this.item.status === 'unknown') {
        lines.push(`${OUTPUT_INDENT}${t.subtle('No result observed (turn ended or connection closed before a tool/result)')}`)
      } else {
        const error = this.item.status === 'error' || this.item.resultIsError
        if (applied.length > 0) {
          if (!error) lines.push(`${OUTPUT_INDENT}${t.muted(this.diffSummary('applied'))}`)
          this.pushDiff(lines, width, true, error)
          if (error) lines.push(`${OUTPUT_INDENT}${t.redSoft(cut(this.errorText(), Math.max(1, width - OUTPUT_INDENT.length)))}`)
        } else {
          if (proposed.length > 0 && !error) {
            lines.push(`${OUTPUT_INDENT}${t.subtle('No applied diff hunk was forwarded · proposal remains unapplied')}`)
          }
          const output = this.outputText()
          const hasImages = this.item.resultImages > 0
          if (output !== '' || (proposed.length === 0 && !hasImages)) {
            this.pushSection(lines, boxes, 'Output', output, width, this.flags.expandedOutputMaxLines ?? 10, 'output', row => error ? t.redSoft(row) : t.muted(row))
          }
        }
        this.pushImageMarkers(lines, boxes, width)
        const duration = this.durationText()
        if (duration !== '') lines.push(`${OUTPUT_INDENT}${t.subtle(duration)}`)
      }
      // A read/terminal card may still carry its native result title; keep the
      // durable facts visible above the I/O body without inventing output.
      if (result?.title !== undefined && call?.title !== result.title) {
        // The native result title is already part of the summary when present.
      }
      const bodyStart = titleRow + 1
      const body = this.bodyBox(bodyStart, lines.length - 1)
      if (body !== undefined) {
        // Declared after the precise details boxes, so a details row always wins
        // the first-match rule. The body itself is click-only: selection/drag
        // stay native and only an undragged click collapses.
        boxes.push(body)
      }
      this.pendingBoxes = boxes
      return lines
    }

    const summary = this.collapsedSummary()
    const duration = summary.error ? '' : this.durationText()
    const hint = this.canExpand() ? this.styledHint('expand', `${key}:result`) : ''
    const content = `${summary.error ? t.redSoft(summary.text) : t.muted(summary.text)}${duration === '' ? '' : t.subtle(` · ${duration}`)}${hint}`
    lines.push(bodyRow(content))
    const resultRow = lines.length - 1
    const resultBox = this.resultBox(resultRow)
    if (resultBox !== undefined) boxes.push(resultBox)
    if (!summary.error) this.pushDiff(lines, width, false, false)
    this.pendingBoxes = boxes
    return lines
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const key = this.viewKey()
    if (this.cache !== undefined && this.cache.width === safeWidth && this.cache.key === key) {
      return this.cache.lines
    }
    const lines = this.build(safeWidth).map(line => fit(line, safeWidth))
    this.cache = { width: safeWidth, key, lines }
    this.syncMouse()
    return lines
  }

  /** Cache key includes every setting, context, hover and real live duration. */
  private viewKey(): string {
    return [
      this.version,
      this.flags.expandTools ? 'expand' : 'fold',
      this.flags.expandedInputMaxLines ?? 5,
      this.flags.expandedOutputMaxLines ?? 10,
      this.flags.toolLabelClip ?? 0,
      this.flags.diffViewMode ?? 'auto',
      this.flags.diffIndicatorMode ?? 'bars',
      this.flags.diffSplitMinWidth ?? 120,
      this.flags.editDiffCollapsedLines ?? 24,
      this.flags.writeDiffCollapsedLines ?? 0,
      this.flags.diffWordWrap === false ? 'nowrap' : 'wrap',
      this.flags.hints?.expand ?? '',
      this.flags.hints?.toolsDetails ?? '',
      this.flags.screen ?? 'inline',
      this.flags.imageDetailsHint ?? '',
      typeof this.flags.onToolDetails === 'function' ? 'details' : '',
      typeof this.flags.onImageDetails === 'function' ? 'images' : '',
      this.cwd,
      this.group?.key ?? '',
      this.group === undefined ? '' : this.group.isExpanded() ? 'group-open' : 'group-closed',
      this.expanded ? 'open' : 'closed',
      this.hovered ?? '',
      this.durationText(),
    ].join('|')
  }

  private syncMouse(): void {
    this.lastBoxes = this.pendingBoxes
    if (this.pendingBoxes.length === 0) this.registry.clear()
    else this.registry.sync(this.pendingBoxes)
  }

  invalidate(): void {
    this.cache = undefined
    // Deliberately does not touch the registry: an ordinary repaint must keep
    // the press pin so a click whose rows moved between frames still lands.
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.registry.handleMouse(event)
  }

  clearMouse(): void {
    this.pendingBoxes = []
    this.lastBoxes = []
    this.hovered = undefined
    this.registry.clear()
    this.cache = undefined
  }

  /** Diagnostics/tests: hitboxes declared by the last render. */
  hitboxes(): readonly MouseHitbox[] {
    return this.lastBoxes
  }
}

function cut(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(1, max - 1))}…` : oneLine
}

function firstLine(text: string): string {
  return sanitize(text).split('\n').find(line => line.trim() !== '') ?? ''
}