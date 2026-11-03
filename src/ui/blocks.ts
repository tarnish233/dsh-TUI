/**
 * Transcript item components in a compact Claude-Code visual language.
 *
 * Rendering rules:
 *   - every component measures with Pi TUI's width helpers and never emits a
 *     line wider than the width passed to render();
 *   - caches are keyed by item identity + version + width + option flags, so a
 *     streaming token only re-renders the one live item;
 *   - tool cards prefer DSH's native `presentCall`/`presentResult` render
 *     intents and fall back to a generic name+argument summary, never to a
 *     guess about what the tool did;
 *   - diffs come from the tool's own before/after hunk (native card or opaque
 *     `tool/result` meta). A hunk has no file coordinates, so no absolute line
 *     numbers are invented for it;
 *   - proposed/running/result states stay distinct, and an unresolved card is
 *     reported as unknown rather than an eternal "Running…";
 *   - active responses render directly; incomplete/unconfirmed responses are marked explicitly.
 *
 * Layout/algorithm attribution: agent_tui (MIT) src/ui/blocks.ts.
 */
import {
  type Component,
  Markdown,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui'
import { diffLines } from 'diff'
import type {
  AssistantTranscriptItem,
  AttemptTranscriptItem,
  NoticeTranscriptItem,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from '../state/transcript.ts'
import { bold, dim, italic, markdownTheme, type Style, t } from './theme.ts'
import { displayPath, fit, oneLine, plural, sanitize, visibleWidth, wrap } from './text.ts'

export interface TranscriptViewOptions {
  showThinking: boolean
  expandTools: boolean
}

const DOT = '⏺'
const HOLLOW = '◌'
const ELBOW = '  ⎿  '
const INDENT = '     '
const MARKER = '⏺ '

export interface ItemBlock extends Component {
  readonly itemId: string
  readonly kind: TranscriptItem['kind']
  readonly version: number
  update(item: TranscriptItem): void
}

export function createItemBlock(item: TranscriptItem, options: TranscriptViewOptions): ItemBlock {
  switch (item.kind) {
    case 'user': return new UserBlock(item, options)
    case 'assistant': return new AssistantBlock(item, options)
    case 'tool': return new ToolBlock(item, options)
    case 'attempt': return new AttemptBlock(item, options)
    case 'notice': return new NoticeBlock(item, options)
  }
}

/** Live and settled text use the same layout; lifecycle bookkeeping stays in the store. */
function assistantContent(width: number, text: string, thinking: string, markdown: Markdown, showThinking: boolean): string[] {
  const out: string[] = []
  const thought = thinking.trim()
  if (thought !== '') {
    if (showThinking) {
      out.push(t.muted('✻') + ' ' + italic(t.muted('Thinking')))
      for (const line of wrap(thought, Math.max(4, width - 2))) out.push('  ' + italic(t.subtle(line)))
    } else {
      out.push(t.muted('✻') + ' ' + italic(t.muted('Thought')) + t.subtle(' (ctrl+t to show)'))
    }
  }
  if (text.trim() !== '') {
    const prefixWidth = visibleWidth(MARKER)
    const body = markdown.render(Math.max(1, width - prefixWidth))
    while (body.length > 0 && body[0]!.trim() === '') body.shift()
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
    for (let index = 0; index < body.length; index += 1) {
      out.push((index === 0 ? t.text(MARKER) : ' '.repeat(prefixWidth)) + body[index]!)
    }
  }
  return out
}

abstract class CachedBlock implements ItemBlock {
  readonly itemId: string
  readonly kind: TranscriptItem['kind']
  version = 0
  protected readonly flags: TranscriptViewOptions
  private cache: { width: number; key: string; lines: string[] } | undefined

  constructor(id: string, kind: TranscriptItem['kind'], version: number, flags: TranscriptViewOptions) {
    this.itemId = id
    this.kind = kind
    this.version = version
    this.flags = flags
  }

  update(item: TranscriptItem): void {
    if (item.version === this.version) return
    this.assign(item)
    this.version = item.version
    this.invalidate()
  }

  protected abstract assign(item: TranscriptItem): void
  protected abstract build(width: number): string[]
  protected viewKey(): string {
    return ''
  }

  invalidate(): void {
    this.cache = undefined
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const key = `${this.version}|${this.viewKey()}`
    if (this.cache !== undefined && this.cache.width === safeWidth && this.cache.key === key) return this.cache.lines
    const lines = this.build(safeWidth).map(line => fit(line, safeWidth))
    this.cache = { width: safeWidth, key, lines }
    return lines
  }
}

// ---------------------------------------------------------------------------

class UserBlock extends CachedBlock {
  private text = ''
  private imageCount = 0

  constructor(item: UserTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'user') return
    this.text = item.text
    this.imageCount = item.imageCount
  }

  protected build(width: number): string[] {
    const chips = this.imageCount > 0
      ? ` ${t.cyan(Array.from({ length: this.imageCount }, (_, index) => `[Image #${index + 1}]`).join(' '))}`
      : ''
    const body = this.text.trim() === '' ? [''] : wrap(this.text.replace(/\s+$/, ''), Math.max(1, width - 2))
    return body.map((line, index) => {
      const content = `${index === 0 ? t.muted('> ') : '  '}${t.text(line)}${index === body.length - 1 ? chips : ''}`
      // A full-width mist-blue band makes human turns easy to distinguish from
      // assistant output. It is the DSH dark theme's selection color.
      return t.userBg(content + ' '.repeat(Math.max(0, width - visibleWidth(content))))
    })
  }
}

// ---------------------------------------------------------------------------

class AssistantBlock extends CachedBlock {
  private text = ''
  private thinking = ''
  private interrupted = false
  private readonly markdown = new Markdown('', 0, 0, markdownTheme)

  constructor(item: AssistantTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'assistant') return
    if (item.text !== this.text) this.markdown.setText(item.text)
    this.text = item.text
    this.thinking = item.thinking
    this.interrupted = item.interrupted
  }

  protected viewKey(): string {
    return this.flags.showThinking ? 'think' : 'plain'
  }

  protected build(width: number): string[] {
    const out = assistantContent(width, this.text, this.thinking, this.markdown, this.flags.showThinking)
    if (this.interrupted) out.push(`${ELBOW}${t.redSoft('Interrupted by user')}`)
    return out
  }
}

// ---------------------------------------------------------------------------

class AttemptBlock extends CachedBlock {
  private text = ''
  private thinking = ''
  private toolNames: readonly string[] = []
  private status: AttemptTranscriptItem['status'] = 'streaming'
  private tentative = true
  private readonly markdown = new Markdown('', 0, 0, markdownTheme)

  constructor(item: AttemptTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'attempt') return
    if (item.text !== this.text) this.markdown.setText(item.text)
    this.text = item.text
    this.thinking = item.thinking
    this.toolNames = item.toolNames
    this.status = item.status
    this.tentative = item.tentative
  }

  protected viewKey(): string {
    return `${this.flags.expandTools ? 'expand' : 'fold'}|${this.flags.showThinking ? 'think' : 'plain'}`
  }

  private label(): string {
    if (this.status === 'unknown') return 'Response result unknown (connection or turn ended)'
    return 'Incomplete response'
  }

  protected build(width: number): string[] {
    if (this.status === 'streaming' || this.status === 'committing') {
      const out = assistantContent(width, this.text, this.thinking, this.markdown, this.flags.showThinking)
      if (this.toolNames.length > 0) out.push(ELBOW + t.subtle('requested: ' + this.toolNames.join(', ')))
      return out
    }
    const out = [`${t.muted(HOLLOW)} ${italic(t.muted(this.label()))}`]
    if (this.thinking.trim() !== '' && this.flags.showThinking) {
      out.push(`${t.muted('✻')} ${italic(t.muted('Thinking'))}`)
      for (const line of wrap(this.thinking.trim(), Math.max(4, width - 2))) out.push(`  ${italic(t.subtle(line))}`)
    }
    if (this.text.trim() !== '') {
      if (this.tentative) {
        // Preserve an incomplete preview with a clear warning, rather than
        // silently presenting it as a completed response.
        const body = this.markdown.render(Math.max(1, width - 2))
        while (body.length > 0 && body[0]!.trim() === '') body.shift()
        while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
        for (const line of body) out.push(`  ${line}`)
      } else {
        const bodyWidth = Math.max(1, width - 2)
        const source = wrap(this.text, bodyWidth)
        const limit = this.flags.expandTools ? 200 : 10
        for (const line of source.slice(0, limit)) out.push(`  ${t.muted(line)}`)
        if (source.length > limit) out.push(`  ${t.subtle(`… +${plural(source.length - limit, 'line')} (ctrl+o to expand)`)}`)
      }
    }
    if (this.toolNames.length > 0) out.push(`${ELBOW}${t.subtle(`requested: ${this.toolNames.join(', ')}`)}`)
    return out
  }
}

// ---------------------------------------------------------------------------

class NoticeBlock extends CachedBlock {
  private level: NoticeTranscriptItem['level'] = 'info'
  private text = ''

  constructor(item: NoticeTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'notice') return
    this.level = item.level
    this.text = item.text
  }

  protected build(width: number): string[] {
    const style = this.level === 'error' ? t.redSoft : t.muted
    const prefix = this.level === 'error' ? ELBOW : `${t.muted('·')} `
    return wrap(sanitize(this.text), Math.max(1, width - visibleWidth(prefix)))
      .map((line, index) => `${index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))}${style(line)}`)
  }
}

// ---------------------------------------------------------------------------

const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  shell: 'Bash',
  exec: 'Bash',
  read: 'Read',
  read_image: 'Read Image',
  edit: 'Update',
  write: 'Write',
  grep: 'Search',
  glob: 'Find',
  find: 'Find',
  ls: 'List',
  webfetch: 'Fetch',
  websearch: 'Web Search',
  todowrite: 'Todo',
}

export function toolDisplayName(name: string): string {
  return TOOL_NAMES[name] ?? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function firstString(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim() !== '') return value
    if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) return value.join(', ')
  }
  return undefined
}

function toolPath(args: Record<string, unknown> | undefined, metaPaths: readonly string[], cwd: string): string {
  const fromArgs = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
  return displayPath(fromArgs ?? metaPaths[0] ?? '', cwd)
}

function toolSummary(name: string, args: Record<string, unknown> | undefined, cwd: string, metaPaths: readonly string[]): string {
  if (args === undefined) return toolPath(undefined, metaPaths, cwd)
  switch (name) {
    case 'bash':
    case 'shell':
    case 'exec':
      return oneLine(args.command ?? args.cmd ?? '', 400)
    case 'read':
    case 'read_image': {
      const path = toolPath(args, metaPaths, cwd)
      const offset = typeof args.offset === 'number' ? args.offset : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      const range = offset !== undefined || limit !== undefined
        ? ` · lines ${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : '+'}`
        : ''
      return path + range
    }
    case 'edit':
    case 'write':
      return toolPath(args, metaPaths, cwd)
    case 'grep':
    case 'glob':
    case 'find': {
      const pattern = oneLine(args.pattern ?? args.glob ?? args.query ?? '', 80)
      const path = typeof args.path === 'string' ? displayPath(args.path, cwd) : ''
      return [pattern !== '' ? `"${pattern}"` : '', path].filter(Boolean).join(', ')
    }
    case 'ls':
      return displayPath(args.path ?? '.', cwd)
    default: {
      const value = firstString(args)
      return value !== undefined ? oneLine(value, 160) : oneLine(args, 160)
    }
  }
}

/**
 * DSH tool render intents (`presentCall` / `presentResult`), forwarded by the
 * backend as an opaque display record. This is presentation only: nothing here
 * decides what a tool did, and nothing is written back to DSH's log.
 *
 * Expected record: `{ call?: ToolCallView, result?: ToolResultView }` from
 * `@deepseek-ai/dsh-tools/presentation`, with a flat single view tolerated for
 * a bridge that forwards only one half.
 */
interface MetaDiff {
  path: string
  oldText: string | null
  newText: string
}

interface CallCard {
  card: 'generic' | 'terminal' | 'diff'
  title?: string
  kind?: string
  description?: string
  cwd?: string
  diffs: MetaDiff[]
  contentText: string
}

interface ReadCard {
  path: string
  offset: number
  totalLines: number
  lang?: string
  lines: Array<{ number: number; text: string }>
}

interface SearchCard {
  files: Array<{ path: string; matches: Array<{ lineNumber: number; line: string }> }>
  paths: string[]
  truncated: boolean
  total: number
}

interface WebCard {
  kind: 'search' | 'fetch'
  sources: Array<{ url: string; title?: string; snippet?: string }>
  answer?: string
  url?: string
  statusCode?: number
  truncated: boolean
}

interface ResultCard {
  card: 'generic' | 'terminal' | 'diff' | 'read' | 'search' | 'web'
  title?: string
  contentText: string
  output?: string
  exitCode?: number
  signal?: string
  diffs: MetaDiff[]
  read?: ReadCard
  search?: SearchCard
  web?: WebCard
}

interface ToolPresentation {
  call?: CallCard
  result?: ResultCard
}

function asRecordValue(value: unknown): Record<string, unknown> | undefined {
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

function readFileDiffs(value: unknown): MetaDiff[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: MetaDiff[] = []
  for (const diff of value.slice(0, 8)) {
    const record = asRecordValue(diff)
    if (record === undefined) continue
    if (typeof record.path !== 'string' || typeof record.newText !== 'string') continue
    const oldText = record.oldText === null ? null : typeof record.oldText === 'string' ? record.oldText : undefined
    if (oldText === undefined) continue
    out.push({ path: record.path, oldText, newText: record.newText })
  }
  return out.length > 0 ? out : undefined
}

/** Tool-private `tool/result` meta (e.g. dsh-tool-fs result-time hunk). */
function readMetaDiffs(meta: unknown): MetaDiff[] | undefined {
  const record = asRecordValue(meta)
  return record === undefined ? undefined : readFileDiffs(record.diffs)
}

function readContentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const texts: string[] = []
  for (const block of value) {
    const record = asRecordValue(block)
    if (record === undefined || record.type !== 'text') continue
    if (typeof record.text === 'string') texts.push(record.text)
  }
  return texts.join('\n\n')
}

function readCallCard(raw: unknown): CallCard | undefined {
  const record = asRecordValue(raw)
  if (record === undefined) return undefined
  if (record.card !== 'generic' && record.card !== 'terminal' && record.card !== 'diff') return undefined
  const call: CallCard = {
    card: record.card,
    diffs: readFileDiffs(record.diffs) ?? [],
    contentText: readContentText(record.content),
  }
  const title = asText(record.title)
  if (title !== undefined) call.title = title
  const kind = asText(record.kind)
  if (kind !== undefined) call.kind = kind
  const description = asText(record.description)
  if (description !== undefined) call.description = description
  const cwd = asText(record.cwd)
  if (cwd !== undefined) call.cwd = cwd
  return call
}

function readReadCard(raw: unknown): ReadCard | undefined {
  const record = asRecordValue(raw)
  if (record === undefined || typeof record.path !== 'string') return undefined
  const lines: ReadCard['lines'] = []
  for (const entry of Array.isArray(record.lines) ? record.lines : []) {
    const line = asRecordValue(entry)
    if (line === undefined) continue
    const number = asCount(line.number)
    if (number === undefined || typeof line.text !== 'string') continue
    lines.push({ number, text: line.text })
  }
  const card: ReadCard = {
    path: record.path,
    offset: asCount(record.offset) ?? lines[0]?.number ?? 1,
    totalLines: asCount(record.totalLines) ?? lines.length,
    lines,
  }
  const lang = asText(record.lang)
  if (lang !== undefined) card.lang = lang
  return card
}

function readSearchCard(raw: unknown): SearchCard | undefined {
  const record = asRecordValue(raw)
  if (record === undefined) return undefined
  const paths = Array.isArray(record.paths)
    ? record.paths.filter((path): path is string => typeof path === 'string')
    : []
  const files: SearchCard['files'] = []
  for (const entry of Array.isArray(record.files) ? record.files : []) {
    const file = asRecordValue(entry)
    if (file === undefined || typeof file.path !== 'string') continue
    const matches: SearchCard['files'][number]['matches'] = []
    for (const matchEntry of Array.isArray(file.matches) ? file.matches : []) {
      const match = asRecordValue(matchEntry)
      if (match === undefined) continue
      const lineNumber = asCount(match.lineNumber)
      if (lineNumber === undefined || typeof match.line !== 'string') continue
      matches.push({ lineNumber, line: match.line })
    }
    files.push({ path: file.path, matches })
  }
  if (paths.length === 0 && files.length === 0) return undefined
  return {
    files,
    paths,
    truncated: record.truncated === true,
    total: asCount(record.total) ?? files.reduce((sum, file) => sum + file.matches.length, paths.length),
  }
}

function readWebCard(raw: unknown): WebCard | undefined {
  const record = asRecordValue(raw)
  if (record === undefined) return undefined
  if (record.kind === 'search') {
    const sources: WebCard['sources'] = []
    for (const entry of Array.isArray(record.sources) ? record.sources : []) {
      const source = asRecordValue(entry)
      if (source === undefined || typeof source.url !== 'string') continue
      const item: WebCard['sources'][number] = { url: source.url }
      const title = asText(source.title)
      if (title !== undefined) item.title = title
      const snippet = asText(source.snippet)
      if (snippet !== undefined) item.snippet = snippet
      sources.push(item)
    }
    const card: WebCard = { kind: 'search', sources, truncated: record.truncated === true }
    const answer = asText(record.answer)
    if (answer !== undefined) card.answer = answer
    return card
  }
  if (record.kind === 'fetch') {
    const card: WebCard = {
      kind: 'fetch',
      sources: [],
      truncated: record.truncated === true,
      url: asText(record.url) ?? '',
    }
    const statusCode = asCount(record.statusCode)
    if (statusCode !== undefined) card.statusCode = statusCode
    return card
  }
  return undefined
}

function readResultCard(raw: unknown): ResultCard | undefined {
  const record = asRecordValue(raw)
  if (record === undefined) return undefined
  const card = record.card
  if (card !== 'generic' && card !== 'terminal' && card !== 'diff' && card !== 'read' && card !== 'search' && card !== 'web') return undefined
  const result: ResultCard = {
    card,
    contentText: readContentText(record.content),
    diffs: readFileDiffs(record.diffs) ?? [],
  }
  const title = asText(record.title)
  if (title !== undefined) result.title = title
  const output = typeof record.output === 'string' ? record.output : undefined
  if (output !== undefined) result.output = output
  const exitCode = asCount(record.exitCode)
  if (exitCode !== undefined) result.exitCode = exitCode
  const signal = asText(record.signal)
  if (signal !== undefined) result.signal = signal
  if (card === 'read') {
    const read = readReadCard(record)
    if (read !== undefined) result.read = read
  } else if (card === 'search') {
    const search = readSearchCard(record)
    if (search !== undefined) result.search = search
  } else if (card === 'web') {
    const web = readWebCard(record)
    if (web !== undefined) result.web = web
  }
  return result
}

/**
 * Split the forwarded record into its pending-call and completed-result halves.
 * `status` only disambiguates a flat single view: a settled card is a result, an
 * unsettled one is a call intent.
 */
function readPresentation(raw: unknown, settled: boolean): ToolPresentation {
  const record = asRecordValue(raw)
  if (record === undefined) return {}
  const callRaw = asRecordValue(record.call)
  const resultRaw = asRecordValue(record.result)
  if (callRaw !== undefined || resultRaw !== undefined) {
    const call = readCallCard(callRaw)
    const result = readResultCard(resultRaw)
    return {
      ...(call === undefined ? {} : { call }),
      ...(result === undefined ? {} : { result }),
    }
  }
  // Flat bridge shape: one card without call/result nesting.
  if (settled) {
    const result = readResultCard(record)
    return result === undefined ? {} : { result }
  }
  const call = readCallCard(record)
  return call === undefined ? {} : { call }
}

interface DiffRow {
  kind: 'add' | 'del' | 'context'
  text: string
}

/**
 * Intra-hunk rendering of the tool's before/after text. DSH's FileDiff carries a
 * hunk, not file coordinates, so these rows deliberately show no line numbers:
 * a hunk-relative number would be misread as an absolute file line.
 */
function buildDiffRows(diff: MetaDiff): DiffRow[] | undefined {
  const before = diff.oldText ?? ''
  const after = diff.newText
  if (before.length + after.length > 150_000) return undefined
  const rows: DiffRow[] = []
  for (const change of diffLines(before, after)) {
    const lines = change.value.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      rows.push({ kind: change.added === true ? 'add' : change.removed === true ? 'del' : 'context', text: line })
    }
  }
  return rows
}

function renderDiffRow(row: DiffRow, width: number): string {
  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const prefix = `${marker} `
  const body = fit(sanitize(row.text), Math.max(1, width - prefix.length))
  if (row.kind === 'add') return t.diffAddBg(`${t.greenBright(prefix)}${t.text(body)}`)
  if (row.kind === 'del') return t.diffDelBg(`${t.redSoft(prefix)}${t.text(body)}`)
  return `${t.subtle(prefix)}${t.muted(body)}`
}

class ToolBlock extends CachedBlock {
  private name = 'tool'
  private argumentsJson = ''
  private status: ToolTranscriptItem['status'] = 'proposed'
  private resultText = ''
  private resultImages = 0
  private resultIsError = false
  private meta: unknown = undefined
  private presentation: unknown = undefined
  private error: ToolTranscriptItem['error'] = undefined
  private localExpand: boolean | undefined
  private cwd = ''

  constructor(item: ToolTranscriptItem, flags: TranscriptViewOptions) {
    super(item.id, item.kind, item.version, flags)
    this.assign(item)
  }

  protected assign(item: TranscriptItem): void {
    if (item.kind !== 'tool') return
    this.name = item.name
    this.argumentsJson = item.arguments
    this.status = item.status
    this.resultText = item.resultText
    this.resultImages = item.resultImages
    this.resultIsError = item.resultIsError
    this.meta = item.meta
    this.presentation = item.presentation
    this.error = item.error
  }

  /** The parent may set the cwd used for compact path display. */
  setCwd(cwd: string): void {
    if (cwd === this.cwd) return
    this.cwd = cwd
    this.invalidate()
  }

  private get expanded(): boolean {
    return this.localExpand ?? this.flags.expandTools
  }

  protected viewKey(): string {
    return `${this.flags.expandTools ? 'expand' : 'fold'}|${this.localExpand === undefined ? 'auto' : this.localExpand ? 'open' : 'closed'}|${this.cwd}`
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined
    this.localExpand = !this.expanded
    this.invalidate()
    return { handled: true, render: true }
  }

  protected build(width: number): string[] {
    const args = parseArguments(this.argumentsJson)
    const settled = this.status === 'done' || this.status === 'error'
    const presentation = readPresentation(this.presentation, settled)
    const call = presentation.call
    const result = presentation.result
    const metaDiffs = readMetaDiffs(this.meta)
    const metaPaths = metaDiffs?.map(diff => diff.path) ?? call?.diffs.map(diff => diff.path) ?? []

    const header = result?.title !== undefined ? oneLine(result.title, 200) : this.headerText(args, call, metaPaths)
    const hollow = this.status === 'proposed' || this.status === 'unknown'
    const dotStyle: Style = this.status === 'done' ? t.green : this.status === 'error' ? t.red : t.muted
    const nameLabel = header !== '' && titleCarriesName(header, this.name) ? '' : bold(t.text(toolDisplayName(this.name)))
    const summary = header === ''
      ? ''
      : nameLabel === '' ? ` ${t.text(header)}` : `(${t.text(header)})`
    const lines = [`${dotStyle(hollow ? HOLLOW : DOT)} ${nameLabel}${summary}`]
    const bodyWidth = Math.max(1, width - INDENT.length)

    if (call?.description !== undefined) lines.push(`${ELBOW}${dim(t.muted(oneLine(call.description, 200)))}`)
    if (call?.card === 'terminal' && call.cwd !== undefined) {
      const cwd = displayPath(call.cwd, this.cwd)
      if (cwd !== '') lines.push(`${ELBOW}${t.subtle(cwd)}`)
    }

    if (this.status === 'proposed') {
      const paths = (call?.diffs ?? []).map(diff => displayPath(diff.path, this.cwd)).filter(path => path !== '')
      const detail = paths.length > 0
        ? `Proposed change for ${paths.slice(0, 3).join(', ')} · not applied yet`
        : 'Proposed · the model requested this call; DSH has not run it'
      lines.push(`${ELBOW}${dim(t.muted(detail))}`)
      return lines
    }
    if (this.status === 'running') {
      lines.push(`${ELBOW}${dim(t.muted('Running…'))}`)
      return lines
    }
    if (this.status === 'unknown') {
      lines.push(`${ELBOW}${dim(t.muted('No result observed (turn ended or connection closed before a tool/result)'))}`)
      return lines
    }

    if (this.status === 'error' || this.resultIsError) {
      const fallback = this.resultText.trim() !== '' ? this.resultText : result?.contentText ?? ''
      const message = this.error?.reason ?? this.error?.code ?? (fallback.trim() === '' ? 'Tool failed' : fallback)
      lines.push(...this.elbow(sanitize(message).split('\n'), bodyWidth, t.redSoft, 8))
      return lines
    }

    const cardLines = result === undefined ? undefined : this.renderResultCard(result, bodyWidth)
    if (cardLines !== undefined && cardLines.length > 0) {
      lines.push(...cardLines)
      return lines
    }

    if (metaDiffs !== undefined) {
      lines.push(...this.renderDiffs(metaDiffs, bodyWidth))
      return lines
    }

    const text = sanitize(this.resultText).replace(/\n+$/, '')
    if (this.name === 'read' || this.name === 'read_image') {
      const count = text === '' ? 0 : text.split('\n').length
      const label = this.resultImages > 0 && text === ''
        ? `Read ${plural(this.resultImages, 'image')}`
        : `Read ${plural(count, 'line')}`
      if (!this.expanded) {
        lines.push(`${ELBOW}${t.muted(label)}${text !== '' ? t.subtle(' (ctrl+o to expand)') : ''}`)
        return lines
      }
      lines.push(...this.elbow([label, ...text.split('\n')], bodyWidth, t.muted, 400))
      return lines
    }
    if (text === '') {
      lines.push(`${ELBOW}${dim('(No output)')}`)
      return lines
    }
    const limit = this.name === 'bash' || this.name === 'shell' || this.name === 'exec' ? 6 : 4
    lines.push(...this.elbow(text.split('\n'), bodyWidth, t.muted, limit))
    return lines
  }

  /** Native card title when present, generic name+argument summary otherwise. */
  private headerText(
    args: Record<string, unknown> | undefined,
    call: CallCard | undefined,
    metaPaths: readonly string[],
  ): string {
    if (call?.card === 'terminal') {
      const command = call.title === undefined ? '' : oneLine(call.title, 400)
      if (command !== '') return command
    }
    if (call?.card === 'diff') {
      const paths = call.diffs.map(diff => displayPath(diff.path, this.cwd)).filter(path => path !== '')
      if (paths.length > 0) return paths.join(', ')
    }
    if (call?.title !== undefined) return oneLine(call.title, 200)
    return toolSummary(this.name, args, this.cwd, metaPaths)
  }

  private renderResultCard(result: ResultCard, width: number): string[] | undefined {
    switch (result.card) {
      case 'diff': {
        if (result.diffs.length === 0) return undefined
        return this.renderDiffs(result.diffs, width)
      }
      case 'terminal': {
        const out: string[] = []
        const output = sanitize(result.output ?? '').replace(/\n+$/, '')
        if (output === '') out.push(`${ELBOW}${dim('(No output)')}`)
        else out.push(...this.elbow(output.split('\n'), width, t.muted, 6))
        if (result.exitCode !== undefined) out.push(`${INDENT}${t.subtle(`exit code ${result.exitCode}`)}`)
        else if (result.signal !== undefined) out.push(`${INDENT}${t.subtle(`signal ${result.signal}`)}`)
        return out
      }
      case 'read': {
        if (result.read === undefined) return undefined
        return this.renderReadCard(result.read, width)
      }
      case 'search': {
        if (result.search === undefined) return undefined
        return this.renderSearchCard(result.search, width)
      }
      case 'web': {
        if (result.web === undefined) return undefined
        return this.renderWebCard(result.web, width)
      }
      case 'generic': {
        const text = sanitize(result.contentText).replace(/\n+$/, '')
        if (text.trim() === '') return undefined
        const limit = this.name === 'bash' || this.name === 'shell' || this.name === 'exec' ? 6 : 4
        return this.elbow(text.split('\n'), width, t.muted, limit)
      }
    }
  }

  /** Real file line numbers come from the native read card, never from a hunk. */
  private renderReadCard(read: ReadCard, width: number): string[] {
    const out: string[] = []
    const path = displayPath(read.path, this.cwd)
    const first = read.lines[0]?.number ?? read.offset
    const last = read.lines[read.lines.length - 1]?.number ?? read.offset
    out.push(`${ELBOW}${t.muted(`Read ${path}`)}${t.subtle(` (${first}-${last} of ${read.totalLines}${read.lang === undefined ? '' : ` · ${read.lang}`})`)}`)
    const limit = this.expanded ? 400 : 8
    const shown = read.lines.slice(0, limit)
    const numberWidth = String(Math.max(last, 1)).length
    for (const line of shown) {
      const number = String(line.number).padStart(numberWidth)
      const body = fit(sanitize(line.text), Math.max(1, width - numberWidth - 1))
      out.push(`${INDENT}${t.subtle(number)} ${t.muted(body)}`)
    }
    if (read.lines.length > shown.length) {
      out.push(`${INDENT}${t.subtle(`… +${plural(read.lines.length - shown.length, 'line')} (ctrl+o to expand)`)}`)
    }
    return out
  }

  private renderSearchCard(search: SearchCard, width: number): string[] {
    const out: string[] = []
    const capped = search.truncated ? ` (capped at ${search.total})` : ''
    if (search.paths.length > 0) {
      out.push(`${ELBOW}${t.muted(plural(search.paths.length, 'path') + capped)}`)
      const limit = this.expanded ? 200 : 8
      for (const path of search.paths.slice(0, limit)) out.push(`${INDENT}${t.text(fit(displayPath(path, this.cwd), width))}`)
      if (search.paths.length > limit) out.push(`${INDENT}${t.subtle(`… +${plural(search.paths.length - limit, 'path')} (ctrl+o to expand)`)}`)
      return out
    }
    const total = search.files.reduce((sum, file) => sum + file.matches.length, 0)
    out.push(`${ELBOW}${t.muted(`${plural(total, 'match')} in ${plural(search.files.length, 'file')}${capped}`)}`)
    let budget = this.expanded ? 200 : 10
    let hidden = 0
    for (const file of search.files) {
      if (budget <= 0) {
        hidden += file.matches.length
        continue
      }
      out.push(`${INDENT}${t.muted(fit(displayPath(file.path, this.cwd), width))}`)
      for (const match of file.matches) {
        if (budget <= 0) {
          hidden += 1
          continue
        }
        budget -= 1
        const number = String(match.lineNumber).padStart(5)
        out.push(`${INDENT}  ${t.subtle(number)} ${t.text(fit(sanitize(match.line), Math.max(1, width - 8)))}`)
      }
    }
    if (hidden > 0) out.push(`${INDENT}${t.subtle(`… +${plural(hidden, 'match')} (ctrl+o to expand)`)}`)
    return out
  }

  private renderWebCard(web: WebCard, width: number): string[] {
    if (web.kind === 'fetch') {
      const out = [`${ELBOW}${t.text(fit(oneLine(web.url, 400), width))}${web.statusCode === undefined ? '' : t.subtle(` · HTTP ${web.statusCode}`)}`]
      if (web.truncated) out.push(`${INDENT}${t.subtle('content truncated')}`)
      return out
    }
    const out = [`${ELBOW}${t.muted(`${plural(web.sources.length, 'source')}${web.truncated ? ' (capped)' : ''}`)}`]
    if (web.answer !== undefined) out.push(`${INDENT}${t.text(fit(oneLine(web.answer, 400), width))}`)
    const limit = this.expanded ? 50 : 5
    for (const source of web.sources.slice(0, limit)) {
      out.push(`${INDENT}${t.text(fit(oneLine(source.title ?? source.url, 200), width))}`)
      out.push(`${INDENT}${t.subtle(fit(source.url, width))}`)
    }
    if (web.sources.length > limit) {
      out.push(`${INDENT}${t.subtle(`… +${plural(web.sources.length - limit, 'source')} (ctrl+o to expand)`)}`)
    }
    return out
  }

  private elbow(source: string[], width: number, style: Style, limit: number): string[] {
    const visible = source.slice(0, this.expanded ? 400 : limit)
    const out = visible.map((line, index) => `${index === 0 ? ELBOW : INDENT}${style(fit(line, width))}`)
    const hidden = source.length - visible.length
    if (hidden > 0) out.push(`${INDENT}${t.subtle(`… +${plural(hidden, 'line')} (ctrl+o to expand)`)}`)
    return out
  }

  private renderDiffs(diffs: MetaDiff[], width: number): string[] {
    const out: string[] = []
    const rowsFor = diffs.map(diff => ({ diff, rows: buildDiffRows(diff) })).filter(entry => entry.rows !== undefined)
    if (rowsFor.length === 0) {
      // Oversized or malformed differential metadata: show the summary only.
      const path = toolPath(parseArguments(this.argumentsJson), diffs.map(diff => diff.path), this.cwd)
      out.push(`${ELBOW}${t.muted('Updated ')}${t.text(path)}${t.muted(' (diff too large to display)')}`)
      return out
    }
    let added = 0
    let removed = 0
    for (const entry of rowsFor) {
      for (const row of entry.rows!) {
        if (row.kind === 'add') added += 1
        else if (row.kind === 'del') removed += 1
      }
    }
    const firstPath = displayPath(rowsFor[0]!.diff.path, this.cwd)
    out.push(`${ELBOW}${t.muted('Updated ')}${t.text(firstPath)}${t.muted(` with ${plural(added, 'addition')} and ${plural(removed, 'removal')}`)}`)
    let budget = this.expanded ? 400 : 16
    let hidden = 0
    for (const [entryIndex, entry] of rowsFor.entries()) {
      const path = displayPath(entry.diff.path, this.cwd)
      if (entryIndex > 0) out.push(`${INDENT}${t.muted(path)}`)
      const rows = entry.rows!
      const shown = rows.slice(0, budget)
      for (const row of shown) out.push(INDENT + renderDiffRow(row, width))
      budget -= shown.length
      hidden += rows.length - shown.length
      if (budget <= 0) break
    }
    if (hidden > 0) out.push(`${INDENT}${t.subtle(`… +${plural(hidden, 'line')} (ctrl+o to expand)`)}`)
    return out
  }
}

/**
 * A native card title usually repeats the tool verb ("Read src/a.ts (1 - 50)").
 * When it already carries the tool name, render it as the card header instead of
 * `Read(Read src/a.ts …)`.
 */
function titleCarriesName(title: string, name: string): boolean {
  const lower = title.toLowerCase()
  const display = toolDisplayName(name).toLowerCase()
  return lower.startsWith(`${display} `) || lower.startsWith(`${name.toLowerCase()} `) || lower === display
}