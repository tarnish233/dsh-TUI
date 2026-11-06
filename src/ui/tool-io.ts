/**
 * Tool I/O projection shared by the transcript card, tool groups and the
 * read-only details view.
 *
 * DSH owns the facts. This module only normalizes what DSH already forwarded
 * (`arguments`, the durable result text, `tool/result` meta and the ephemeral
 * `presentCall`/`presentResult` cards) into display/copy text. It never runs a
 * tool, never re-reads a file, and never upgrades `proposed`/`running`/
 * `unknown` into an executed result.
 *
 * Contract (owned by the parent, do not change signatures):
 *
 *   getToolSummary(item, cwd, labelClip) -> { label, text, durationMs? }
 *   toolInputText(item)                  -> complete human-readable arguments
 *   toolOutputText(item)                 -> real result/card/meta/error text
 *   toolCopyText(item, section)          -> lossless copy payload
 */
import { diffLines } from 'diff'
import type { ImageAttachmentRef } from '../backend/types.ts'
import { asImageAttachmentRef } from '../attachments.ts'
import type { ToolTranscriptItem } from '../state/transcript.ts'
import { formatImageBytes, imageMediaLabel, toolResultImageRefs } from './image-data.ts'
import type { ToolIoSection, ToolSummaryInfo } from './tool-view.ts'

export type { ToolIoSection }
export type { ToolSummaryInfo }

/** One shared LCS budget for visual and textual diff projection. */
export const DIFF_LCS_CHAR_LIMIT = 150_000

/** Tools whose native card / name makes a duration meaningful. */
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'exec', 'powershell', 'pwsh', 'sh', 'zsh', 'cmd'])

const TOOL_LABELS: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  exec: 'Bash',
  powershell: 'PowerShell',
  read: 'Read',
  read_image: 'Read Image',
  edit: 'Update',
  write: 'Write',
  apply_patch: 'Apply Patch',
  grep: 'Search',
  glob: 'Find',
  find: 'Find',
  ls: 'List',
  webfetch: 'Fetch',
  websearch: 'Web Search',
  todowrite: 'Todo',
  mcp: 'MCP',
  mcpscript: 'MCP Script',
}

/** CC-style display name: a small brand map first, then humanization. */
export function toolDisplayName(name: string): string {
  const key = name.toLowerCase()
  const known = TOOL_LABELS[key]
  if (known !== undefined) return known
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

export function isShellTool(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase())
}

/** Real DSH duration text: ms under 1s, seconds under a minute, then m/h. */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = ms / 1000
  if (seconds < 1) return `${Math.round(ms)}ms`
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainder = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${remainder}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`
}

function clipText(text: string, labelClip: number): string {
  if (!Number.isFinite(labelClip) || labelClip <= 0) return text
  const chars = Array.from(text)
  return chars.length <= labelClip ? text : `${chars.slice(0, Math.max(1, labelClip - 1)).join('')}…`
}

function oneLineValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return text.replace(/\s+/g, ' ').trim()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Native line numbers, offsets and counts must be non-negative safe integers. */
function asSafeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export interface MetaDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

export type ToolCardKind = 'generic' | 'terminal' | 'diff' | 'read' | 'search' | 'web'

export interface CallCard {
  readonly card: 'generic' | 'terminal' | 'diff'
  readonly title?: string
  readonly kind?: string
  readonly description?: string
  readonly cwd?: string
  readonly diffs: readonly MetaDiff[]
  readonly contentText: string
  readonly truncated?: boolean
}

export interface ReadCard {
  readonly path: string
  readonly offset: number
  /** Native whole-file line count when DSH forwarded one (not the returned slice). */
  readonly totalLines?: number
  readonly lang?: string
  readonly lines: ReadonlyArray<{ readonly number: number; readonly text: string }>
  readonly truncated?: boolean
}

export interface SearchCard {
  readonly files: ReadonlyArray<{
    readonly path: string
    readonly matches: ReadonlyArray<{ readonly lineNumber: number; readonly line: string }>
  }>
  readonly paths: readonly string[]
  readonly truncated: boolean
  /** Native total only when DSH explicitly forwarded it. */
  readonly total?: number
}

export interface WebCard {
  readonly kind: 'search' | 'fetch'
  readonly sources: ReadonlyArray<{ readonly url: string; readonly title?: string; readonly snippet?: string }>
  readonly answer?: string
  readonly url?: string
  readonly statusCode?: number
  readonly truncated: boolean
}

export interface ResultCard {
  readonly card: ToolCardKind
  readonly title?: string
  readonly contentText: string
  readonly output?: string
  readonly exitCode?: number
  readonly signal?: string
  readonly truncated?: boolean
  readonly total?: number
  readonly diffs: readonly MetaDiff[]
  readonly read?: ReadCard
  readonly search?: SearchCard
  readonly web?: WebCard
}

export interface ToolPresentation {
  readonly call?: CallCard
  readonly result?: ResultCard
}

function readContentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const texts: string[] = []
  for (const block of value) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'text') continue
    if (typeof record.text === 'string') texts.push(record.text)
  }
  return texts.join('\n\n')
}

function readFileDiffs(value: unknown): MetaDiff[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: MetaDiff[] = []
  for (const diff of value) {
    const record = asRecord(diff)
    if (record === undefined) continue
    if (typeof record.path !== 'string' || typeof record.newText !== 'string') continue
    const oldText = record.oldText === null ? null : typeof record.oldText === 'string' ? record.oldText : undefined
    if (oldText === undefined) continue
    out.push({ path: record.path, oldText, newText: record.newText })
  }
  return out
}

function readCallCard(raw: unknown): CallCard | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  if (record.card !== 'generic' && record.card !== 'terminal' && record.card !== 'diff') return undefined
  const card: CallCard = {
    card: record.card,
    diffs: readFileDiffs(record.diffs) ?? [],
    contentText: readContentText(record.content),
  }
  const title = asText(record.title)
  const kind = asText(record.kind)
  const description = asText(record.description)
  const cwd = asText(record.cwd)
  const truncated = asBoolean(record.truncated)
  return {
    ...card,
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
    ...(description === undefined ? {} : { description }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(truncated === undefined ? {} : { truncated }),
  }
}

function readReadCard(raw: unknown): ReadCard | undefined {
  const record = asRecord(raw)
  if (record === undefined || typeof record.path !== 'string') return undefined
  const lines: Array<{ number: number; text: string }> = []
  for (const entry of Array.isArray(record.lines) ? record.lines : []) {
    const line = asRecord(entry)
    if (line === undefined) continue
    const number = asSafeCount(line.number)
    if (number === undefined || typeof line.text !== 'string') continue
    lines.push({ number, text: line.text })
  }
  const offset = asSafeCount(record.offset)
  // `totalLines` is the whole file's line count, never the returned slice.
  const totalLines = asSafeCount(record.totalLines)
  const card: ReadCard = {
    path: record.path,
    offset: offset ?? lines[0]?.number ?? 0,
    lines,
    ...(totalLines === undefined ? {} : { totalLines }),
  }
  const lang = asText(record.lang)
  const truncated = asBoolean(record.truncated)
  return {
    ...card,
    ...(lang === undefined ? {} : { lang }),
    ...(truncated === undefined ? {} : { truncated }),
  }
}

function readSearchCard(raw: unknown): SearchCard | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === 'string')
    : []
  const files: Array<{
    path: string
    matches: Array<{ lineNumber: number; line: string }>
  }> = []
  for (const entry of Array.isArray(record.files) ? record.files : []) {
    const file = asRecord(entry)
    if (file === undefined || typeof file.path !== 'string') continue
    const matches: Array<{ lineNumber: number; line: string }> = []
    for (const matchEntry of Array.isArray(file.matches) ? file.matches : []) {
      const match = asRecord(matchEntry)
      if (match === undefined) continue
      const lineNumber = asSafeCount(match.lineNumber)
      if (lineNumber === undefined || typeof match.line !== 'string') continue
      matches.push({ lineNumber, line: match.line })
    }
    files.push({ path: file.path, matches })
  }
  // A native zero-hit search card is a valid result: keep 0 matches / 0 paths
  // instead of dropping the card and falling back to a caption.
  const total = asSafeCount(record.total)
  return {
    files,
    paths,
    truncated: record.truncated === true,
    ...(total === undefined ? {} : { total }),
  }
}

function readWebCard(raw: unknown): WebCard | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  if (record.kind === 'search') {
    const sources: Array<{ url: string; title?: string; snippet?: string }> = []
    for (const entry of Array.isArray(record.sources) ? record.sources : []) {
      const source = asRecord(entry)
      if (source === undefined || typeof source.url !== 'string') continue
      const title = asText(source.title)
      const snippet = asText(source.snippet)
      sources.push({
        url: source.url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
      })
    }
    const answer = asText(record.answer)
    return {
      kind: 'search',
      sources,
      truncated: record.truncated === true,
      ...(answer === undefined ? {} : { answer }),
    }
  }
  if (record.kind === 'fetch') {
    const url = asText(record.url) ?? ''
    const statusCode = asCount(record.statusCode)
    return {
      kind: 'fetch',
      sources: [],
      url,
      truncated: record.truncated === true,
      ...(statusCode === undefined ? {} : { statusCode }),
    }
  }
  return undefined
}

function readResultCard(raw: unknown): ResultCard | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const card = record.card
  if (card !== 'generic' && card !== 'terminal' && card !== 'diff' && card !== 'read' && card !== 'search' && card !== 'web') return undefined
  const base: ResultCard = {
    card,
    contentText: readContentText(record.content),
    diffs: readFileDiffs(record.diffs) ?? [],
  }
  const title = asText(record.title)
  const output = typeof record.output === 'string' ? record.output : undefined
  const exitCode = asCount(record.exitCode)
  const signal = asText(record.signal)
  const truncated = asBoolean(record.truncated)
  const total = asCount(record.total)
  const read = card === 'read' ? readReadCard(record) : undefined
  const search = card === 'search' ? readSearchCard(record) : undefined
  const web = card === 'web' ? readWebCard(record) : undefined
  return {
    ...base,
    ...(title === undefined ? {} : { title }),
    ...(output === undefined ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(total === undefined ? {} : { total }),
    ...(read === undefined ? {} : { read }),
    ...(search === undefined ? {} : { search }),
    ...(web === undefined ? {} : { web }),
  }
}

/**
 * Split the forwarded record into call/result halves. A flat card is read as a
 * result once DSH settled the call and as a call intent before that; `status`
 * only disambiguates that bridge shape and is never used to invent an outcome.
 */
export function readToolPresentation(raw: unknown, settled: boolean): ToolPresentation {
  const record = asRecord(raw)
  if (record === undefined) return {}
  const callRaw = asRecord(record.call)
  const resultRaw = asRecord(record.result)
  if (callRaw !== undefined || resultRaw !== undefined) {
    const call = readCallCard(callRaw)
    const result = readResultCard(resultRaw)
    return {
      ...(call === undefined ? {} : { call }),
      ...(result === undefined ? {} : { result }),
    }
  }
  if (settled) {
    const result = readResultCard(record)
    return result === undefined ? {} : { result }
  }
  const call = readCallCard(record)
  return call === undefined ? {} : { call }
}

export function isToolSettled(item: ToolTranscriptItem): boolean {
  return item.status === 'done' || item.status === 'error'
}

export function toolPresentationOf(item: ToolTranscriptItem): ToolPresentation {
  return readToolPresentation(item.presentation, isToolSettled(item))
}

/** Opaque `tool/result` meta (`{ diffs: [...] }`) without trusting other keys. */
export function toolMetaDiffs(meta: unknown): MetaDiff[] | undefined {
  const record = asRecord(meta)
  return record === undefined ? undefined : readFileDiffs(record.diffs)
}

/**
 * Diffs DSH actually applied to files: only a settled non-error result's
 * `result.diffs` or the opaque `tool/result` meta. A call-side proposal is
 * never evidence of an applied change.
 */
export function toolAppliedDiffs(item: ToolTranscriptItem): MetaDiff[] {
  if (item.status !== 'done' || item.resultIsError) return []
  const presentation = toolPresentationOf(item)
  const result = presentation.result?.diffs
  if (result !== undefined && result.length > 0) return [...result]
  const meta = toolMetaDiffs(item.meta)
  return meta === undefined ? [] : [...meta]
}

/** Call-side hunks: a request/proposal, never an applied file effect. */
export function toolProposedDiffs(item: ToolTranscriptItem): MetaDiff[] {
  const call = toolPresentationOf(item).call?.diffs
  return call === undefined ? [] : [...call]
}

/** Compatibility alias: the applied diffs (never the call proposal). */
export function toolDiffs(item: ToolTranscriptItem): MetaDiff[] {
  return toolAppliedDiffs(item)
}

/** True when the card/name represents a shell execution with a real duration. */
export function isTerminalTool(item: ToolTranscriptItem, presentation = toolPresentationOf(item)): boolean {
  return isShellTool(item.name)
    || presentation.call?.card === 'terminal'
    || presentation.result?.card === 'terminal'
}

/** Native call/result title if DSH forwarded one. */
export function toolNativeTitle(item: ToolTranscriptItem, presentation = toolPresentationOf(item)): string | undefined {
  return presentation.result?.title ?? presentation.call?.title
}

/**
 * Merge a native title with the single display label. A native title that
 * starts with the raw tool name (`Edit …`) or our alias (`Update …`) keeps only
 * one verb: the display label plus the title's remaining payload. The callId and
 * tool name remain DSH identity; only the visible label is normalized.
 */
function mergeNativeTitle(title: string, name: string): string {
  const clean = oneLineValue(title)
  const lower = clean.toLowerCase()
  const label = toolDisplayName(name)
  const display = label.toLowerCase()
  if (lower === display || lower.startsWith(`${display} `)) return clean
  const raw = name.toLowerCase()
  if (lower === raw) return label
  if (lower.startsWith(`${raw} `)) return `${label}${clean.slice(name.length)}`
  return `${label} ${clean}`
}

function argumentString(args: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (args === undefined) return ''
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
    if (Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string')) return value.join(', ')
  }
  return ''
}

function argumentPath(args: Record<string, unknown> | undefined): string {
  const value = args?.file_path ?? args?.path
  return typeof value === 'string' ? value : ''
}

function fallbackSummary(item: ToolTranscriptItem, args: Record<string, unknown> | undefined, cwd: string): string {
  const presentation = toolPresentationOf(item)
  const fromDiffs = toolAppliedDiffs(item)[0]?.path
    ?? presentation.result?.diffs[0]?.path
    ?? presentation.call?.diffs[0]?.path
    ?? ''
  const path = displayToolPath(argumentPath(args) || fromDiffs, cwd)
  const name = item.name.toLowerCase()
  if (SHELL_TOOL_NAMES.has(name)) return oneLineValue(argumentString(args, ['command', 'cmd']))
  if (name === 'read' || name === 'read_image') {
    const offset = asCount(args?.offset)
    const limit = asCount(args?.limit)
    const range = offset !== undefined || limit !== undefined
      ? ` · lines ${offset ?? 1}${limit === undefined ? '+' : `-${(offset ?? 1) + limit - 1}`}`
      : ''
    return path + range
  }
  if (name === 'edit' || name === 'write' || name === 'apply_patch') return path
  if (name === 'grep' || name === 'glob' || name === 'find') {
    const pattern = oneLineValue(argumentString(args, ['pattern', 'glob', 'query']))
    return [pattern === '' ? '' : `"${pattern}"`, path].filter(Boolean).join(', ')
  }
  if (name === 'ls') return displayToolPath(argumentString(args, ['path']) || '.', cwd)
  if (name === 'websearch') return oneLineValue(argumentString(args, ['query']))
  if (name === 'webfetch') return oneLineValue(argumentString(args, ['url']))
  if (args !== undefined) {
    const preferred = argumentString(args, ['command', 'cmd', 'query', 'pattern', 'url', 'file_path', 'path', 'name', 'description', 'prompt', 'message'])
    if (preferred !== '') return oneLineValue(preferred)
    const values = Object.values(args).find(value => typeof value === 'string' && value.trim() !== '')
    if (typeof values === 'string') return oneLineValue(values)
    if (Object.keys(args).length > 0) return oneLineValue(args)
  }
  return ''
}

/** Compact path: cwd-relative when inside the workspace, otherwise unchanged. */
export function displayToolPath(path: unknown, cwd: string): string {
  if (typeof path !== 'string' || path === '') return ''
  if (!path.startsWith('/') || cwd === '') return path
  const base = cwd.replace(/\/+$/, '')
  if (path === base) return '.'
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  return path
}

/** Parse a tool-call argument string without throwing on malformed model output. */
export function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return asRecord(value)
  } catch {
    return undefined
  }
}

/**
 * Collapsed summary line, including the label exactly once.
 *
 * Native call/result titles win; without one the real tool name is paired with
 * the real argument payload. A duration is returned only for shell/terminal
 * cards so a fast read/edit cannot advertise a made-up timing.
 */
export function getToolSummary(item: ToolTranscriptItem, cwd: string, labelClip: number): ToolSummaryInfo {
  const presentation = toolPresentationOf(item)
  const label = toolDisplayName(item.name)
  const title = toolNativeTitle(item, presentation)
  const args = parseToolArguments(item.arguments)
  let text: string
  if (title !== undefined && title.trim() !== '') {
    text = mergeNativeTitle(title, item.name)
  } else {
    const detail = fallbackSummary(item, args, cwd)
    text = detail === '' ? label : `${label} ${detail}`
  }
  const durationMs = isTerminalTool(item, presentation) && item.durationMs !== undefined && Number.isFinite(item.durationMs)
    ? item.durationMs
    : undefined
  return {
    label,
    text: clipText(text, labelClip),
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

// ---------------------------------------------------------------------------
// Input

const PREFERRED_FIELDS = [
  'path',
  'file_path',
  'command',
  'cmd',
  'query',
  'pattern',
  'glob',
  'url',
  'name',
  'description',
  'message',
  'content',
  'old_string',
  'new_string',
  'offset',
  'limit',
] as const

function indent(text: string): string {
  return text.split('\n').map(line => `  ${line}`).join('\n')
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === 'string') return sanitizeText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[unserializable]'
  }
}

/**
 * Complete, human-first argument formatting. Unlike a compact card preview this
 * keeps every field and never applies the 8k preview cap; callers decide how
 * many display rows to show.
 */
export function toolInputText(item: ToolTranscriptItem): string {
  const raw = item.arguments
  const lines: string[] = []
  if (raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      lines.push(sanitizeText(raw).replace(/\s+$/, ''))
      parsed = undefined
    }
    if (parsed !== undefined) {
      if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') {
        lines.push(formatArgumentValue(parsed))
      } else {
        const args = parsed as Record<string, unknown>
        const entries = Object.entries(args).filter(([, value]) => value !== undefined)
        const preferredIndex = (key: string): number => {
          const index = PREFERRED_FIELDS.indexOf(key as typeof PREFERRED_FIELDS[number])
          return index === -1 ? Number.MAX_SAFE_INTEGER : index
        }
        entries.sort(([left], [right]) => {
          const leftIndex = preferredIndex(left)
          const rightIndex = preferredIndex(right)
          if (leftIndex !== rightIndex) return leftIndex - rightIndex
          return left.localeCompare(right)
        })
        for (const [key, value] of entries) {
          const safeKey = sanitizeText(key)
          if (typeof value === 'string' && value.includes('\n')) {
            lines.push(`${safeKey}:`)
            lines.push(indent(sanitizeText(value).replace(/\s+$/, '')))
          } else {
            const formatted = formatArgumentValue(value)
            if (formatted.includes('\n')) {
              lines.push(`${safeKey}:`)
              lines.push(indent(formatted))
            } else {
              lines.push(`${safeKey}: ${formatted}`)
            }
          }
        }
      }
    }
  }
  // The call-side diff is a proposal. Keep the complete source here so a done
  // call that forwarded no result hunk still retains what was requested, while
  // never presenting it as an applied file change.
  const proposed = toolProposedDiffs(item)
  if (proposed.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(item.status === 'proposed'
      ? 'Requested changes (not applied yet):'
      : 'Requested changes (input preview, not execution result):')
    for (const diff of proposed) {
      lines.push(`  ${diff.path}`)
      lines.push('    Before:')
      lines.push(indent(sanitizeText(diff.oldText ?? '(no previous content)')))
      lines.push('    After:')
      lines.push(indent(sanitizeText(diff.newText)))
    }
  }
  return lines.join('\n')
}

function sanitizeText(text: string): string {
  // Control bytes from a model/tool payload must never reach the renderer.
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

// ---------------------------------------------------------------------------
// Output

function appendUnique(parts: string[], text: string): void {
  const clean = text.replace(/\s+$/, '')
  if (clean.trim() === '') return
  if (parts.some(part => part === clean)) return
  parts.push(clean)
}

function diffHeading(diffs: readonly MetaDiff[], cwd: string): string {
  if (diffs.length === 1) {
    const diff = diffs[0]!
    return `diff ${displayToolPath(diff.path, cwd)}`
  }
  if (diffs.length === 0) return 'diff (no hunks forwarded)'
  return `diff ${diffs.length} files`
}

interface PlainDiffRow {
  readonly kind: 'add' | 'del' | 'context'
  readonly text: string
}

/** Real line diff for textual details/copy; only called inside the LCS budget. */
function plainDiffRows(before: string, after: string): PlainDiffRow[] {
  const rows: PlainDiffRow[] = []
  for (const change of diffLines(before, after)) {
    const lines = change.value.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      rows.push({ kind: change.added === true ? 'add' : change.removed === true ? 'del' : 'context', text: line })
    }
  }
  return rows
}

/** Complete raw source for a structured diff; never runs LCS or drops text. */
export function diffSourceText(diffs: readonly MetaDiff[], cwd = ''): string {
  const lines: string[] = []
  for (const diff of diffs) {
    lines.push(`${displayToolPath(diff.path, cwd)}${diff.oldText === null ? ' (new file)' : ''}`)
    lines.push('Before:')
    lines.push(diff.oldText ?? '(no previous content)')
    lines.push('After:')
    lines.push(diff.newText)
  }
  return lines.join('\n')
}

function renderDiffText(diffs: readonly MetaDiff[], cwd: string): string {
  if (diffs.length === 0) return ''
  const lines: string[] = [diffHeading(diffs, cwd)]
  for (const diff of diffs) {
    const before = diff.oldText ?? ''
    if (before.length + diff.newText.length > DIFF_LCS_CHAR_LIMIT) {
      // Same budget as the visual renderer: no LCS on a huge hunk. Keep the
      // complete native before/after so details/copy stay lossless.
      lines.push(`${displayToolPath(diff.path, cwd)}: hunk too large for line diff`)
      lines.push('Before:')
      lines.push(sanitizeText(diff.oldText ?? '(no previous content)'))
      lines.push('After:')
      lines.push(sanitizeText(diff.newText))
      continue
    }
    const rows = plainDiffRows(before, diff.newText)
    const added = rows.filter(row => row.kind === 'add').length
    const removed = rows.filter(row => row.kind === 'del').length
    lines.push(`${displayToolPath(diff.path, cwd)}: +${added} -${removed}`)
    for (const row of rows) {
      lines.push(`${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '} ${sanitizeText(row.text)}`)
    }
  }
  return lines.join('\n')
}

function plural(count: number, word: string): string {
  if (word === 'match') return `${count} ${count === 1 ? 'match' : 'matches'}`
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function readCardText(card: ReadCard, cwd: string): string {
  const lines: string[] = []
  const path = displayToolPath(card.path, cwd)
  const lang = card.lang === undefined ? '' : ` · ${card.lang}`
  if (card.lines.length === 0) {
    const total = card.totalLines === undefined ? '' : ` of ${card.totalLines}`
    lines.push(`Read ${path} (no lines returned${total}${lang})`)
  } else {
    const first = card.lines[0]?.number ?? card.offset
    const last = card.lines[card.lines.length - 1]?.number ?? card.offset
    const total = card.totalLines === undefined ? '' : ` of ${card.totalLines}`
    lines.push(`Read ${path} (${first}-${last}${total}${lang})`)
    for (const line of card.lines) lines.push(`${String(line.number).padStart(5)} ${sanitizeText(line.text)}`)
  }
  if (card.truncated === true) lines.push('… native read card truncated')
  return lines.join('\n')
}

function cappedSuffix(card: { readonly truncated: boolean; readonly total?: number }): string {
  if (!card.truncated) return ''
  return card.total === undefined ? ' (truncated)' : ` (capped at ${card.total})`
}

function searchCardText(card: SearchCard, cwd: string): string {
  const lines: string[] = []
  const capped = cappedSuffix(card)
  if (card.paths.length > 0) {
    lines.push(`${plural(card.paths.length, 'path')}${capped}`)
    for (const path of card.paths) lines.push(displayToolPath(path, cwd))
    return lines.join('\n')
  }
  const total = card.files.reduce((sum, file) => sum + file.matches.length, 0)
  lines.push(`${plural(total, 'match')} in ${plural(card.files.length, 'file')}${capped}`)
  for (const file of card.files) {
    lines.push(displayToolPath(file.path, cwd))
    for (const match of file.matches) lines.push(`${String(match.lineNumber).padStart(5)} ${sanitizeText(match.line)}`)
  }
  return lines.join('\n')
}

function webCardText(card: WebCard): string {
  const lines: string[] = []
  if (card.kind === 'fetch') {
    if (card.url !== undefined && card.url !== '') lines.push(card.url)
    if (card.statusCode !== undefined) lines.push(`HTTP ${card.statusCode}`)
    if (card.truncated) lines.push('content truncated')
    if (lines.length === 0) lines.push('Fetch result (no URL forwarded)')
    return lines.join('\n')
  }
  lines.push(`${plural(card.sources.length, 'source')}${card.truncated ? ' (capped)' : ''}`)
  if (card.answer !== undefined) lines.push(card.answer)
  for (const source of card.sources) {
    lines.push(source.title === undefined ? source.url : `${source.title} — ${source.url}`)
    if (source.snippet !== undefined) lines.push(source.snippet)
  }
  return lines.join('\n')
}

/** Main text of a native card without its separate native annotations. */
function resultCardBody(card: ResultCard, cwd: string): string {
  switch (card.card) {
    case 'terminal': return sanitizeText(card.output ?? '').replace(/\s+$/, '')
    case 'diff': return renderDiffText(card.diffs, cwd)
    case 'read': return card.read === undefined ? '' : readCardText(card.read, cwd)
    case 'search': return card.search === undefined ? '' : searchCardText(card.search, cwd)
    case 'web': return card.web === undefined ? '' : webCardText(card.web)
    case 'generic':
    default: return sanitizeText(card.contentText).replace(/\s+$/, '')
  }
}

/** Native annotations that must not be merged into (or duplicated with) text. */
function resultCardAnnotations(card: ResultCard): string[] {
  const notes: string[] = []
  if (card.card === 'terminal') {
    if (card.truncated === true) notes.push('… native terminal output truncated')
    if (card.exitCode !== undefined) notes.push(`exit code ${card.exitCode}`)
    if (card.signal !== undefined) notes.push(`signal ${card.signal}`)
  } else if (card.card === 'generic' && card.truncated === true) {
    notes.push('… native generic content truncated')
  }
  return notes
}

function resultCardText(card: ResultCard, item: ToolTranscriptItem, cwd: string): string {
  const parts: string[] = []
  const body = resultCardBody(card, cwd)
  if (body !== '') parts.push(body)
  parts.push(...resultCardAnnotations(card))
  if (item.resultImages > 0) parts.push(`${plural(item.resultImages, 'image')} returned`)
  return parts.join('\n')
}

function resultBlocks(item: ToolTranscriptItem): readonly unknown[] {
  if (Array.isArray(item.resultContent)) return item.resultContent
  const raw = asRecord(item.rawResult)
  const message = asRecord(raw?.message)
  return Array.isArray(message?.content) ? message.content : []
}

function looksLikeBase64(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return compact.length >= 128
    && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
    && compact.length % 4 === 0
}

/**
 * JSON for custom/structured blocks. Only recognizable binary payloads are
 * replaced: explicit base64 fields, data:*;base64 URIs, image/file/binary
 * holders and Buffer byte arrays. Ordinary custom JSON `data` strings are
 * preserved verbatim.
 */
function binarySafeJson(value: unknown): string {
  try {
    return JSON.stringify(value, function (this: Record<string, unknown>, key: string, entry: unknown) {
      const holderType = typeof this.type === 'string' ? this.type.toLowerCase() : ''
      const binaryHolder = holderType === 'image' || holderType === 'file' || holderType === 'binary'
      if (typeof entry === 'string') {
        if (key === 'base64') return `[binary omitted: ${entry.length} chars]`
        if (key === 'data' || key === 'blob') {
          if (binaryHolder) return `[binary omitted: ${entry.length} chars]`
          if (/^data:[^,]*;base64,/i.test(entry)) return `[binary omitted: ${entry.length} chars]`
          if (looksLikeBase64(entry)) return `[binary omitted: ${entry.length} chars]`
        }
        return entry
      }
      if (key === 'data' && holderType === 'buffer' && Array.isArray(entry) && entry.length >= 64
        && entry.every(item => typeof item === 'number')) {
        return `[binary omitted: ${entry.length} bytes]`
      }
      return entry
    }, 2) ?? ''
  } catch {
    return '[unserializable]'
  }
}

/**
 * Canonical image refs of a durable tool result, in declared block order.
 *
 * The attachment lives under the native block's `attachment` field; reading
 * only a top-level mime/name would mislabel every real result. A flat ref shape
 * is accepted for older fixtures, but no attachment is invented from a bare
 * legacy `{type:'image'}` block.
 */
export function toolImageRefs(item: ToolTranscriptItem): ImageAttachmentRef[] {
  return toolResultImageRefs(item)
}

/**
 * Reference lines for native attachments/custom blocks. Image/file bytes are
 * never read, downloaded, decoded or dumped into the clipboard.
 *
 * `imageRefs: 'omit'` is for transcript cards, which render each real ref as a
 * compact clickable marker instead of a second metadata paragraph. The copy
 * payload and the details view keep the full source metadata.
 */
export function toolAttachmentText(
  item: ToolTranscriptItem,
  imageRefs: 'source' | 'omit' = 'source',
): string {
  const refs: string[] = []
  let imageBlocks = 0
  for (const block of resultBlocks(item)) {
    const record = asRecord(block)
    if (record === undefined) continue
    const type = asText(record.type)
    if (type === 'image') {
      imageBlocks += 1
      const attachment = asImageAttachmentRef(record.attachment) ?? asImageAttachmentRef(record)
      // Real refs are rendered as markers on the card; omit only their textual
      // duplicate. A no-ref/legacy image block stays explained, otherwise a
      // card with one real marker would be silent about the second image.
      if (attachment !== undefined && imageRefs === 'omit') continue
      if (attachment !== undefined) {
        const original = attachment.originalDimensions
        const details = [
          attachment.name === undefined || attachment.name === '' ? '' : attachment.name,
          imageMediaLabel(attachment.mediaType),
          `${attachment.width}×${attachment.height}`,
          formatImageBytes(attachment.bytes),
          `id ${attachment.attachmentId}`,
          original === undefined ? '' : `original ${original.width}×${original.height}`,
        ].filter(Boolean).join(' · ')
        refs.push(`[image] ${details}`)
        continue
      }
      // Legacy flat fields are preserved as reference metadata, but they are
      // never promoted into a clickable attachment.
      const mime = asText(record.mimeType) ?? asText(record.mediaType)
      const name = asText(record.name) ?? asText(record.filename)
      const data = typeof record.data === 'string' ? record.data : undefined
      const details = [
        mime === undefined ? '' : mime,
        name === undefined ? '' : name,
        data === undefined ? '' : `${data.length} encoded chars omitted`,
        'no attachment ref; not viewable',
      ].filter(Boolean).join(' · ')
      refs.push(`[image]${details === '' ? '' : ` ${details}`}`)
      continue
    }
    if (type === 'file') {
      const path = asText(record.path) ?? asText(record.filename) ?? asText(record.name) ?? ''
      const mime = asText(record.mimeType) ?? asText(record.mediaType)
      const details = [path, mime === undefined ? '' : mime].filter(Boolean).join(' · ')
      refs.push(`[file]${details === '' ? '' : ` ${details}`} (reference only; not read)`)
      continue
    }
    if (type === 'text' || type === undefined) continue
    refs.push(`[${type}] ${binarySafeJson(record).replace(/\n/g, '\n  ')}`)
  }
  if (item.resultImages > imageBlocks) {
    const extra = item.resultImages - imageBlocks
    refs.push(`[image] ${plural(extra, 'image')} returned without display refs (not viewable)`)
  }
  return refs.join('\n')
}

function rawResultTruncated(item: ToolTranscriptItem): boolean {
  const record = asRecord(item.rawResult)
  return record?.truncated === true
}

/** Merge text while keeping the most complete version once. */
function mergeComplete(parts: string[], text: string): void {
  const clean = text.replace(/\s+$/, '')
  if (clean.trim() === '') return
  const existing = parts.findIndex(part => part.includes(clean))
  if (existing >= 0) return
  const shorter = parts.findIndex(part => clean.includes(part))
  if (shorter >= 0) {
    parts[shorter] = clean
    return
  }
  parts.push(clean)
}

/**
 * Does a structured native body already carry every line of the durable text?
 * Line-number gutters and headings are ignored; a short caption like `read ok`
 * is not covered by the card's lines and therefore stays as its own fact.
 */
function durableCoveredByNative(nativeBody: string, durable: string): boolean {
  const body = nativeBody.replace(/\s+$/, '')
  if (body === '' || durable.trim() === '') return false
  if (body.includes(durable)) return true
  const bodyLines = body.split('\n').map(line => line.trim()).filter(Boolean)
  const durableLines = durable.replace(/\s+$/, '').split('\n').map(line => line.trim()).filter(Boolean)
  if (durableLines.length === 0) return true
  return durableLines.every(line => bodyLines.some(bodyLine =>
    bodyLine === line || bodyLine.endsWith(` ${line}`) || bodyLine.includes(` ${line} `)))
}

function resultAnnotations(card: ResultCard | undefined, item: ToolTranscriptItem): string[] {
  const notes: string[] = []
  if (card !== undefined) notes.push(...resultCardAnnotations(card))
  if (rawResultTruncated(item)) notes.push('… durable result truncated')
  return notes
}

/**
 * Complete output for the details view / expanded card: the durable result
 * text, native card payload (terminal/read/search/web/diff), attachments and
 * error metadata. Preview row budgets belong to the renderer, not here.
 */
export function toolOutputText(
  item: ToolTranscriptItem,
  options: { readonly imageRefs?: 'source' | 'omit' } = {},
): string {
  if (item.status === 'proposed' || item.status === 'running' || item.status === 'unknown') return ''
  const presentation = toolPresentationOf(item)
  const card = presentation.result
  const parts: string[] = []
  if (item.error !== undefined) {
    const message = item.error.reason ?? item.error.code ?? item.error.name
    appendUnique(parts, [message, item.error.code !== undefined && item.error.reason !== undefined ? `(${item.error.code})` : ''].filter(Boolean).join(' '))
  }
  if (card !== undefined) {
    const body = resultCardBody(card, '')
    const errorOutcome = item.status === 'error' || item.resultIsError
    mergeComplete(parts, errorOutcome && card.card === 'diff' ? `Reported diff source (tool error; application status unconfirmed):\n${body}` : body)
  }
  const structuredCard = card !== undefined && (card.card === 'read' || card.card === 'search' || card.card === 'web')
  const durable = readContentText(resultBlocks(item))
  const durableText = durable !== '' ? durable : sanitizeText(item.resultText)
  if (structuredCard) {
    const nativeBody = resultCardBody(card!, '')
    // Keep a durable caption/annotation that the native rows do not carry.
    if (!durableCoveredByNative(nativeBody, durableText)) mergeComplete(parts, durableText)
  } else {
    mergeComplete(parts, durableText)
  }
  const applied = toolAppliedDiffs(item)
  if (applied.length > 0) {
    mergeComplete(parts, renderDiffText(applied, ''))
  } else if (card === undefined) {
    const metaDiffs = toolMetaDiffs(item.meta)
    if (metaDiffs !== undefined && metaDiffs.length > 0) {
      const body = renderDiffText(metaDiffs, '')
      const errorOutcome = item.status === 'error' || item.resultIsError
      mergeComplete(parts, errorOutcome ? `Reported diff source (tool error; application status unconfirmed):\n${body}` : body)
    }
  }
  const attachments = toolAttachmentText(item, options.imageRefs ?? 'source')
  if (attachments !== '') mergeComplete(parts, attachments)
  for (const note of resultAnnotations(card, item)) {
    if (!parts.some(part => part.includes(note))) parts.push(note)
  }
  return parts.join('\n')
}

/**
 * Copy payload, never a rendered preview: Input is the exact argument string
 * DSH recorded; Output keeps plain text byte-for-byte and, when structured
 * data exists, adds the complete source diff/attachment metadata without
 * recomputing line diffs or dumping binary payloads.
 */
export function toolCopyText(item: ToolTranscriptItem, section: ToolIoSection): string {
  if (section === 'input') return item.arguments
  // A proposed/running/unknown call has no settled result to copy; stale
  // preview bytes must not be passed off as the tool's output.
  if (!isToolSettled(item) && item.status !== 'error') return ''
  const blocks = resultBlocks(item)
  const content = readContentText(blocks)
  const applied = toolAppliedDiffs(item)
  const attachments = toolAttachmentText(item)
  const hasNonText = blocks.some(block => {
    const record = asRecord(block)
    return record !== undefined && record.type !== undefined && record.type !== 'text'
  })
  const resultCard = toolPresentationOf(item).result
  const nativeCardText = resultCard !== undefined && (resultCard.card === 'read' || resultCard.card === 'search' || resultCard.card === 'web')
    ? resultCardBody(resultCard, '')
    : ''
  const metaDiffs = toolMetaDiffs(item.meta) ?? []
  const sourceDiffs = applied.length > 0
    ? applied
    : resultCard !== undefined && resultCard.diffs.length > 0
      ? [...resultCard.diffs]
      : metaDiffs
  const structured = sourceDiffs.length > 0 || attachments !== '' || hasNonText || item.resultImages > 0 || nativeCardText !== ''
  if (!structured) {
    if (content !== '') return content
    if (item.resultText !== '') return item.resultText
    const card = toolPresentationOf(item).result
    if (card !== undefined) {
      const text = resultCardText(card, item, '')
      if (text !== '') return text
    }
    if (item.error !== undefined) return item.error.reason ?? item.error.code ?? item.error.name
    if (item.rawResult !== undefined) return binarySafeJson(item.rawResult)
    return ''
  }
  const parts: string[] = []
  const durable = content !== '' ? content : item.resultText
  if (nativeCardText !== '') {
    // Preserve a durable caption that the native rows do not cover, then the
    // complete readable native source (row text + metadata header).
    if (durable !== '' && !durableCoveredByNative(nativeCardText, durable)) parts.push(durable)
    if (parts.length > 0) parts.push('')
    parts.push(`Native ${resultCard!.card} card (source):`)
    parts.push(nativeCardText)
  } else if (durable !== '') {
    parts.push(durable)
  }
  if (attachments !== '') {
    if (parts.length > 0) parts.push('')
    parts.push('Attachments / structured blocks (references only):')
    parts.push(attachments)
  }
  if (sourceDiffs.length > 0) {
    if (parts.length > 0) parts.push('')
    if (applied.length > 0) {
      parts.push('Structured diff (source, no line-diff recomputation):')
    } else {
      parts.push('Reported diff source (tool error; application status unconfirmed):')
    }
    parts.push(diffSourceText(sourceDiffs))
  }
  const meta = asRecord(item.meta)
  if (meta !== undefined) {
    const keys = Object.keys(meta).filter(key => key !== 'diffs')
    if (keys.length > 0) {
      if (parts.length > 0) parts.push('')
      parts.push('Metadata:')
      parts.push(binarySafeJson(meta))
    }
  }
  for (const note of resultAnnotations(toolPresentationOf(item).result, item)) {
    if (!parts.some(part => part.includes(note))) parts.push(note)
  }
  if (parts.length === 0) {
    if (item.error !== undefined) return item.error.reason ?? item.error.code ?? item.error.name
    if (item.rawResult !== undefined) return binarySafeJson(item.rawResult)
    return ''
  }
  return parts.join('\n')
}