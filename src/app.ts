import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  Container, getNativeClipboard, isViewportTUI,
  matchesKey, ProcessTerminal, ScrollView, Spacer, Text, truncateToWidth, visibleWidth,
  type Component, type Focusable, type KeyId, type NativeClipboard, type Terminal, type TUI,
  type TuiInputListenerResult,
  TuiAltScreen, TuiMainScreen, VStack,
} from '#pi-tui'
import type {
  Backend, BackendEvent, DecisionOption, DecisionRequest, DisplayContentPart, PromptContentPart, QueueEntry, SessionInfo, SkillCatalogSnapshot, StatsSnapshot, SubagentEntry, TranscriptCodec, UsageSnapshot,
} from './backend/types.ts'
import { configDirectory, KeybindingsStore, PromptHistory, SettingsStore, type Settings } from './config.ts'
import { HistorySearch } from './history-search.ts'
import { CcEditor, createCcKeymap, NativeAutocompleteProvider, type CcActionEvent, type CcDraftSnapshot, type CcKeymap, type CcKeymapConfig, type CcSubmitPayload } from './input/index.ts'
import { leadingSkillGestureName, readSkillCatalog } from './skills.ts'
import { NativeUiController } from './native-ui-controller.ts'
import { readLocalFileInput } from './local-file.ts'
import type { WorkingDirectoryRead } from './backend/native-inspection.ts'
import { oneLine, sanitize } from './ui/text.ts'
import { formatElapsed, formatOutputRate, formatOutputTokens, OutputTracker } from './state/output-stats.ts'
import type { TodosSnapshot } from './backend/types.ts'
import { createGitStatsRefresher, readGitStats, type GitStats } from './state/git-stats.ts'
import { TranscriptStore } from './state/transcript.ts'
import { DecisionDialog, SelectDialog } from './ui/dialogs.ts'
import { HelpPanel, type HelpCommand } from './ui/help.ts'
import { KeybindingsDialog } from './ui/keybindings.ts'
import { ModelPickerDialog, type ModelPickerItem } from './ui/model-picker.ts'
import { SessionPickerDialog } from './ui/session-picker.ts'
import { SettingsDialog, type SettingsViewState, type NativeSettingsEntry } from './ui/settings.ts'
import { modalHeight, modalOverlayOptions, type ModalSize } from './ui/modal.ts'
import { QueueDialog } from './ui/queue-dialog.ts'
import { HitboxRegistry } from './ui/mouse.ts'
import { QueueList } from './ui/queue-list.ts'
import { ToolDetailsDialog } from './ui/tool-details.ts'
import { ImageDetailsDialog } from './ui/image-details.ts'
import { AgentsOverlay, type AgentsViewState } from './ui/agents-overlay.ts'
import { ChildSessionView } from './ui/child-session-view.ts'
import { SubagentProgress } from './ui/subagent-progress.ts'
import { TodoBoard } from './ui/todo-board.ts'
import { GoalProgress } from './ui/goal-progress.ts'
import { StatusDockStack } from './ui/status-dock-stack.ts'
import { subagentCanReply, subagentCanStop, subagentLabel } from './ui/subagent-format.ts'
import { getTranscriptImages } from './ui/image-data.ts'
import { resetImageDisplayCache } from './ui/image-cache.ts'
import type { ImageDetailsRequest, ImageViewItem } from './ui/image-view.ts'
import { asFileAttachmentRef, displayContentParts, imageAttachmentValue, imageMediaTypeFromBytes } from './attachments.ts'
import { clearToolExpansion } from './ui/tool-expansion.ts'
import { toolPreferences, type ToolDetailsRequest } from './ui/tool-view.ts'
import { TranscriptView, transcriptHints, type TranscriptViewHints, type TranscriptViewOptionsShape } from './ui/transcript.ts'
import { dim, editorTheme, t } from './ui/theme.ts'
import { WelcomeHeader } from './ui/welcome.ts'
import { TerminalIntegration, type TerminalEnvironment } from './ui/terminal-integration.ts'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

const GIT_ICON = '\u{f418}'
const CACHE_ICON = '\u{f01bc}'
const CONTEXT_BAR_WIDTH = 10

/** TTFT display: milliseconds under a second, one decimal above. */
function formatTtft(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * CC-style rainbow marker for the top effort level: three vivid theme hues,
 * one per character, so `max` visibly cycles colors instead of wearing a
 * single accent. Static (no timer/animation) and width-safe: every hue is a
 * zero-width SGR wrapper around the same character.
 */
const EFFORT_RAINBOW = [t.pink, t.orange, t.cyan] as const

/** Wrap each character in the next hue of `hues`, cycling through them. */
function colorCycled(text: string, hues: readonly ((value: string) => string)[]): string {
  let out = ''
  let index = 0
  for (const character of Array.from(text)) {
    out += hues[index % hues.length](character)
    index += 1
  }
  return out
}

/** git status symbols colored by role: conflict/behind red, modified yellow, untracked muted, ahead green. */
function styledGitStatus(status: string): string {
  let out = ''
  for (const char of status) {
    if (char === '=' || char === '\u21e3') out += t.red(char)
    else if (char === '!') out += t.yellow(char)
    else if (char === '?') out += t.muted(char)
    else if (char === '\u21e1') out += t.green(char)
    else out += t.subtle(char)
  }
  return out
}
const EXIT_ARM_MS = 1_000
/** One renderer-owned clock/frame family for the editor and live child progress. */
const WORKING_SPINNER_FRAMES = ['·', '✻', '✶', '✳'] as const
/** Bound on graceful DSH close after the terminal is already restored. */
const SHUTDOWN_CLOSE_MS = 8_000
/** Shared 品牌蓝 (brand blue) for the prompt, working status and chrome. */
const accent = t.accent
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

function admittedUserMessageId(event: { data: unknown }): string | undefined {
  const data = object(event.data)
  const message = object(data?.message) ?? data
  const source = object(message?.source)
  if (source !== undefined && source.kind !== 'user') return undefined
  return typeof message?.id === 'string' ? message.id : undefined
}

function readQueueEntries(value: unknown): QueueEntry[] {
  if (!Array.isArray(value)) return []
  const rows: QueueEntry[] = []
  for (const item of value) {
    const row = object(item)
    if (row === undefined || typeof row.messageId !== 'string') continue
    const images = typeof row.images === 'number' && Number.isFinite(row.images) ? row.images : 0
    rows.push({
      messageId: row.messageId,
      text: typeof row.text === 'string' ? row.text : '',
      target: row.target === 'next-step' ? 'next-step' : 'next-turn',
      images,
      ...(typeof row.files === 'number' && Number.isSafeInteger(row.files) && row.files >= 0 ? { files: row.files } : {}),
    })
  }
  return rows
}

function sameQueue(left: readonly QueueEntry[], right: readonly QueueEntry[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return false
    if (a.messageId !== b.messageId || a.text !== b.text || a.target !== b.target || a.images !== b.images || (a.files ?? 0) !== (b.files ?? 0)) return false
  }
  return true
}
/** Optional lifecycle hooks are called only when the owning component exposes them. */
const disposeComponent = (value: unknown): void => {
  if (value === null || value === undefined) return
  const dispose = (value as { dispose?: () => void }).dispose
  if (typeof dispose === 'function') dispose.call(value)
}

/** Native identity is retained only for display grouping, never command routing. */
type CommandCatalogEntry = HelpCommand & { definitionId?: string }

const UI_COMMANDS = [
  { name: 'help', description: 'Display commands and custom commands' },
  { name: 'settings', description: 'TUI preferences' },
  { name: 'model', description: 'Choose a DSH model' },
  { name: 'effort', description: 'Choose the model reasoning effort' },
  { name: 'preset', description: 'Choose a DSH agent preset' },
  { name: 'agent', description: 'View native subagents and their session history' },
  { name: 'resume', description: 'Resume a DSH session (picker lists this directory)' },
  { name: 'new', description: 'New DSH session' },
  { name: 'reload', description: 'Reload TUI settings/keybindings and DSH configuration/plugins' },
  { name: 'exit', description: 'Exit' },
]
const OPTIONAL_UI_COMMANDS = [
  { name: 'jobs', description: 'Inspect native jobs and retained output', capability: 'native-jobs' },
  { name: 'inspect', description: 'Read mounted native plugins and capabilities', capability: 'native-inventory' },
  { name: 'questions', description: 'View and answer native continued questions', capability: 'continued-questions' },
  { name: 'rename', description: 'Explicitly rename the current native session', capability: 'session-rename' },
  { name: 'fork', description: 'Fork the durable native conversation and switch', capability: 'session-fork' },
  { name: 'attach', description: 'Attach one local file through native DSH storage', capability: 'file-input', inputHint: '[local-path]' },
] as const
const UI_COMMAND_NAMES = new Set([...UI_COMMANDS.map(command => command.name), 'quit', 'config', 'clear'])

class PromptEditor extends CcEditor {
  private workingStatus = ''

  /** Render the live working status inside the editor's top border. */
  setWorkingStatus(status: string): void {
    if (this.workingStatus === status) return
    this.workingStatus = status
    this.invalidate()
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    const base = super.renderTopBorder(width, hiddenLineCount)
    if (this.workingStatus === '' || width <= 4) return base
    const status = truncateToWidth(this.workingStatus, Math.max(1, width - 4), '')
    const statusWidth = visibleWidth(status)
    if (statusWidth === 0) return base
    // The status replaces the border's left edge so the spinner aligns with
    // the `❯` prompt and the transcript markers, with no `── ` notch in front.
    return status + this.borderColor(' ' + '─'.repeat(Math.max(0, width - statusWidth - 1)))
  }

  render(width: number): string[] {
    const lines = super.render(width)
    // The prompt arrow is the 品牌蓝, like the editor frame it sits in.
    if (lines.length > 2 && lines[1]?.startsWith('  ')) lines[1] = accent('❯') + ' ' + lines[1].slice(2)
    return lines
  }
}

class Prompt implements Component, Focusable {
  editor: PromptEditor
  onKey?: (data: string) => boolean
  private _focused = false
  constructor(tui: TUI, keymap: CcKeymap) { this.editor = new PromptEditor(tui, editorTheme, { paddingX: 2, keymap }) }
  setWorkingStatus(status: string): void { this.editor.setWorkingStatus(status) }
  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value; this.editor.focused = value }
  get capturesViewportInput(): boolean { return this.editor.capturesViewportInput }
  render(width: number): string[] { return this.editor.render(width) }
  invalidate(): void { this.editor.invalidate() }
  handleInput(data: string): void { if (!this.onKey?.(data)) this.editor.handleInput(data) }
}

export interface AppOptions {
  backend: Backend
  cwd: string
  screen?: 'inline' | 'fullscreen'
  configDir?: string
  terminal?: Terminal
  /** Terminal/multiplexer hints only; offline acceptance injects these without native configuration. */
  terminalEnvironment?: TerminalEnvironment
  demo?: boolean
  initialPrompt?: string
  registerSignals?: boolean
  /** A native host owns shutdown signals, independently of Unix suspend/resume. */
  allowSuspend?: boolean
  /** User-triggered tool copy; offline acceptance injects this rather than touching a real clipboard. */
  copyText?: (text: string) => Promise<void>
  /** Native clipboard injection for offline image/text acceptance; never a credential/config subsystem. */
  clipboard?: NativeClipboard
  /**
   * `--resume` without a session id: open the directory session picker at
   * startup instead of resuming a known id. Esc keeps the fresh session.
   */
  resumePicker?: boolean
}

/**
 * One UI operation's identity. DSH owns the session/attachment; the editor
 * identity and epoch catch a same-session reattachment or replacement while
 * an asynchronous palette catalog, clipboard read or send is in flight.
 */
interface UiContext {
  sessionId: string | undefined
  attachmentId: string | undefined
  route: string
  editor: CcEditor
  epoch: number
}

interface PresetPickerState {
  readonly dialog: SelectDialog
  readonly context: UiContext
  readonly surface: number
  catalog?: Record<string, unknown>
}

interface PendingDecision {
  sessionId: string
  /** Attachment observed when the native request arrived. */
  attachmentId?: string
  request: DecisionRequest
}

/** One explicit main-Editor destination; DSH still owns delivery and execution. */
interface SubagentReplyTarget {
  rootSessionId: string
  childId: string
  parentSessionId: string
  label: string
}

interface DecisionDialogExtras {
  /** Newer dialog surfaces expose a global-cancel hook separate from Esc. */
  onInterrupt?: () => void
}

/** A native dequeue transfer receipt held only until explicit editing succeeds. Never an execution queue. */
interface QueuedAttachmentRecovery {
  readonly text: string
  readonly messageId?: string
  readonly content: readonly DisplayContentPart[]
}

export class App {
  readonly tui: TUI
  readonly store = new TranscriptStore()
  /** Local exit intent after synchronous terminal restoration; native DSH owns the deadline. */
  readonly exitRequested: Promise<number>
  /** Quiescence of this App's owned cleanup, independent from the native exit request. */
  readonly exited: Promise<number>
  readonly keymap: CcKeymap
  private resolveExitRequested!: (code: number) => void
  private resolveExit!: (code: number) => void
  private readonly options: AppOptions
  private readonly settings: SettingsStore
  private readonly keybindings: KeybindingsStore
  private readonly directory: string
  private readonly screen: 'inline' | 'fullscreen'
  /** Fullscreen transcript scroll host; the click-anchor freezes/restores it. */
  private scrollView: ScrollView | undefined
  private hoverScrollTop: number | undefined
  private terminalPointerActive = true
  /** ScrollTop captured when a disclosure click disabled follow; null when idle. */
  private anchoredScrollTop: number | null = null
  private readonly followHitboxes = new HitboxRegistry()
  private readonly queueList = new QueueList({
    sendNow: id => { void this.sendQueued(id) },
    edit: id => { this.editQueued(id) },
    cancel: id => { void this.cancelQueued(id) },
    changed: () => this.render(),
  })
  private readonly modeBindings: CcKeymapConfig
  private history: PromptHistory
  private readonly histories = new Map<string, PromptHistory>()
  private readonly viewOptions: TranscriptViewOptionsShape
  private readonly transcript: TranscriptView
  private readonly subagentProgress: SubagentProgress
  private readonly todoBoard: TodoBoard
  private readonly goalProgress: GoalProgress
  private readonly statusDockStack: StatusDockStack
  private readonly nativeUi: NativeUiController
  private nativeDirectory?: WorkingDirectoryRead
  private fileAttachController?: AbortController
  private readonly prompt: Prompt
  private readonly welcome: WelcomeHeader
  private readonly slot = new Container()
  private readonly footer = new Text('', 0, 0)
  private readonly hint = new Text('', 0, 0)
  private readonly bottom = new Container()
  private info?: SessionInfo
  private busy = false
  private connected = false
  private fatal = false
  private closing = false
  private started = false
  private terminalPaused = false
  private readonly terminalIntegration: TerminalIntegration
  private off?: () => void
  private dialog?: Component
  private dialogOverlay?: ReturnType<TUI['showOverlay']>
  private settingsReturnState?: { view: SettingsViewState; context: UiContext }
  private appliedQueueCollapsed = false
  private imagePreviewIntent?: Settings['imagePreview']
  private imagePreviewGeneration = 0
  private settingsFeedback?: { message: string; error: boolean; context: UiContext }
  private toolDetailsOverlay?: {
    request: ToolDetailsRequest
    dialog: ToolDetailsDialog
    handle: ReturnType<TUI['showOverlay']>
  }
  private imageDetailsOverlay?: {
    request: ImageDetailsRequest
    dialog: ImageDetailsDialog
    handle: ReturnType<TUI['showOverlay']>
  }
  private agentsOverlay?: {
    dialog: AgentsOverlay
    handle: ReturnType<TUI['showOverlay']>
  }
  private childSessionOverlay?: {
    childId: string
    /** A real child snapshot is absent while the read-only loading shell is open. */
    info?: SessionInfo
    context: UiContext
    store: TranscriptStore
    dialog: ChildSessionView
    handle: ReturnType<TUI['showOverlay']>
    returnToList: boolean
    returnState?: AgentsViewState
  }
  /** Frames observed while native follow/read establishes the child durable cut. */
  private pendingChildFollow?: {
    childId: string
    surface: number
    events: BackendEvent[]
    overflow: boolean
  }
  /** The single root Editor can address one native continuable child at a time. */
  private subagentReplyTarget?: SubagentReplyTarget
  private readonly pendingSubagentStops = new Set<string>()
  private clipboardGeneration = 0
  private clipboardPending = false
  private decisionId?: string
  private readonly decisions: PendingDecision[] = []
  private readonly activeCommands = new Map<string, string>()
  private nativeCommands: CommandCatalogEntry[] = []
  private catalogRequest?: { sessionId: string; attachmentId: string | undefined; dirty: boolean; promise: Promise<void> }
  private modelCatalogRequest?: { context: UiContext; dialog: ModelPickerDialog; surface: number; dirty: boolean; promise: Promise<void> }
  private presetPicker?: PresetPickerState
  private presetCatalogRequest?: { state: PresetPickerState; dirty: boolean; promise: Promise<void> }
  private autocomplete?: { editor: CcEditor; basePath: string; provider: NativeAutocompleteProvider }
  private skillCatalog?: SkillCatalogSnapshot
  private skillsDirty = true
  private skillRevision = 0
  private skillsRequest?: { context: UiContext; revision: number; dirty: boolean; promise: Promise<void> }
  /** UI intent only: late metadata may refresh an open query, never revive an Esc/focus-dismissed one. */
  private skillAutocompleteIntent?: { context: UiContext; surface: number; generation: number; text: string; signal?: AbortSignal }
  private inputGeneration = 0
  /** The startup connect() task; the resume overlay awaits it before listing. */
  private connecting?: Promise<SessionInfo>
  /** Confirmed per-session titles (null = no title) within this launch. */
  private readonly sessionTitles = new Map<string, string | null>()
  /** Ids waiting for the next coalesced `titles` request. */
  private readonly sessionTitleIds = new Set<string>()
  private titleTimer?: NodeJS.Timeout
  /**
   * Footer context/cache/total facts. Fed by the bridge's `metrics` frames
   * during a turn and by the native `state` command at baselines.
   */
  private usage?: { used: number; size?: number; cachePct?: number; totalTokens?: number }
  /** Native sessionStats fold (turns/steps, rate, TTFT): `metrics` frames plus `state` baselines. */
  private stats?: { decodeTokens?: number; decodeMs?: number; ttftMs?: number; ttftSteps?: number; turns?: number; steps?: number }
  /** Latest native todos snapshot of the current session (null = cleared). */
  private todos: TodosSnapshot = null
  /** Last seen native plan-mode state; toggles surface as notices. */
  private planActive: boolean | undefined
  /** Read-only git observations for the footer's second line. */
  private gitStats?: GitStats
  private gitRefresher?: { refresh(): void; dispose(): void }
  private gitTimer?: NodeJS.Timeout
  private codec?: TranscriptCodec
  private stashed?: CcDraftSnapshot
  private cleared?: CcDraftSnapshot
  private restored?: { text: string; before: CcDraftSnapshot }
  private updatingDraft = false
  private queueRecallPending = false
  private queueReadController?: AbortController
  /** Ref-only retry receipts: bytes stay in DSH, and no message is automatically re-sent. */
  private readonly queuedAttachmentRecoveries = new Map<string, readonly QueuedAttachmentRecovery[]>()
  private queued = 0
  private queueRows: QueueEntry[] = []
  private readonly queueRemovals = new Set<string>()
  /** Inbox ids already written into the transcript. They are the current turn, not a queue. */
  private readonly admittedUserMessageIds = new Set<string>()
  /** Row whose text is in the composer. Enter writes it back; it is not sent. */
  private editingQueueId?: string
  private queueRequest?: { epoch: number; promise: Promise<void>; dirty: boolean }
  private nextSendMode?: 'followup' | 'steer' | 'send-now'
  private nextPreset?: string
  private exitArm?: { at: number; id: string }
  private exitTimer?: NodeJS.Timeout
  private escapeAt = 0
  private spinner?: NodeJS.Timeout
  private watcher?: FSWatcher
  private spinnerStep = 0
  private startedAt = 0
  private readonly output = new OutputTracker()
  private chordHint?: string[]
  private readonly warnings: string[] = []
  private readonly signals: Array<[NodeJS.Signals, () => void]> = []
  private offInput?: () => void
  private offTerminalFocus?: () => void
  private epoch = 0
  /** Increments on every applied SessionInfo; catches a ready event landing mid-command. */
  private infoStamp = 0
  /** Increments when a local dialog opens/closes; stale async pickers must not replace it. */
  private surfaceGeneration = 0
  private terminalRestored = false
  private editorChild?: ChildProcess
  private nativeAutoTitle?: { available: boolean; enabled?: boolean; detail?: string }

  constructor(options: AppOptions) {
    this.options = options
    this.directory = options.configDir ?? configDirectory()
    this.settings = new SettingsStore(this.directory)
    this.keybindings = new KeybindingsStore(this.directory)
    this.history = new PromptHistory(options.cwd, this.directory)
    this.histories.set(options.cwd, this.history)
    const settings = this.settings.get()
    this.screen = options.screen ?? settings.screen
    this.modeBindings = {
      'historySearch.next': ['ctrl+r', 'down', 'ctrl+n'],
      'historySearch.previous': ['ctrl+shift+r', 'up', 'ctrl+p'],
      'historySearch.accept': this.screen === 'inline' ? ['enter', 'tab', 'escape'] : ['enter', 'tab'],
      'historySearch.cancel': this.screen === 'inline' ? ['ctrl+c'] : ['escape', 'ctrl+c'],
      'app.message.sendNow': ['ctrl+enter'],
      'app.message.steer': ['ctrl+x ctrl+s'],
      'app.message.followUp': ['ctrl+x enter'],
    }
    this.keymap = createCcKeymap({ bindings: this.modeBindings, chordTimeoutMs: 3000 })
    this.viewOptions = {
      ...toolPreferences(settings),
      groupSubagentMessages: settings.groupSubagentMessages,
      suppressLiveTodos: true,
      showThinking: settings.showThinking, hints: this.viewHints(),
      thinkingPreviewLines: settings.thinkingPreviewLines,
      screen: this.screen,
      thinkingLiveTimerMs: settings.thinkingLiveTimerMs,
      onRenderRequest: () => this.render(),
      onViewportAnchor: expanding => this.anchorTranscriptViewport(expanding),
      onToolDetails: request => this.openToolDetails(request),
      onImageDetails: request => this.openImageDetails(request),
      imageDetailsHint: this.keymap.getBindings('app.images.details')[0],
      onSubagentDetails: sessionId => { void this.openSubagentSession(sessionId) },
      subagentDetailsHint: this.keymap.getBindings('app.subagents.details')[0],
    }
    const terminal = options.terminal ?? new ProcessTerminal()
    this.tui = this.screen === 'fullscreen'
      ? new TuiAltScreen(terminal, false, undefined, { copyOnSelect: settings.copyOnSelect })
      : new TuiMainScreen(terminal)
    this.terminalIntegration = new TerminalIntegration({
      terminal, cwd: options.cwd, env: options.terminalEnvironment ?? process.env,
    })
    this.prompt = new Prompt(this.tui, this.keymap)
    this.welcome = new WelcomeHeader({ demo: options.demo })
    this.transcript = new TranscriptView(this.store, this.viewOptions)
    const app = this
    this.todoBoard = new TodoBoard({
      keymap: this.keymap, hint: () => true, trailingSeparator: false,
    })
    this.goalProgress = new GoalProgress()
    this.subagentProgress = new SubagentProgress({
      keymap: this.keymap, trailingSeparator: false,
      // Overlay close only asks Pi to repaint; sample the current owner rather
      // than keeping the last App.render() value blocked until another key.
      get mouseBlocked() { return app.closing || app.terminalPaused || app.dialog !== undefined || app.viewOptions.mouseBlocked === true },
      onOpenAgents: () => this.openAgentsOverlay(),
      onOpenChild: entry => { void this.openSubagentSession(entry.id) },
      onRenderRequest: () => this.render(),
    })
    this.statusDockStack = new StatusDockStack({
      todos: this.todoBoard, goal: this.goalProgress, agents: this.subagentProgress,
      maxRows: () => this.statusDockPool(),
      agentsEnabled: () => this.settings.get().showSubagentProgress,
    })
    this.nativeUi = new NativeUiController({
      tui: this.tui, keymap: this.keymap, backend: options.backend,
      info: () => this.info, capture: () => this.context(),
      isCurrent: context => !this.closing && this.epoch === context.epoch && this.editor === context.editor &&
        this.info?.sessionId === context.sessionId && this.info?.attachmentId === context.attachmentId,
      dialog: () => this.dialog, show: dialog => this.showDialog(dialog), dismiss: () => this.dismissDialog(),
      render: () => this.render(), report: (message, error) => this.store.report(message, error ? 'error' : 'info'),
      interrupt: () => this.interrupt(), returnToSettings: () => this.returnToSettings(), settingsOpen: () => this.dialog instanceof SettingsDialog,
      goal: value => { this.goalProgress.status = value }, directory: value => { this.nativeDirectory = value },
      renamed: (sessionId, title) => {
        if (this.info?.sessionId !== sessionId) return
        this.info.title = title; this.sessionTitles.set(sessionId, title); this.render()
      },
      sessionCommand: (name, args) => this.runRemote(name, args, 'status-only'),
    })
    this.exitRequested = new Promise(resolve => { this.resolveExitRequested = resolve })
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    this.terminalPointerActive = terminal.terminalFocused !== false
    this.offTerminalFocus = terminal.onFocusChange?.(focused => this.handleTerminalFocus(focused))
  }

  get editor(): CcEditor { return this.prompt.editor }
  get session(): SessionInfo | undefined { return this.info }
  get isBusy(): boolean { return this.busy || this.activeCommands.size > 0 }
  get pendingDecisionCount(): number { return this.decisions.length }
  get queuedCount(): number { return this.queued }
  get replyTargetSessionId(): string | undefined { return this.subagentReplyTarget?.childId }

  /** Native diagnostic notices use the existing report plane, never the input draft. */
  reportNativeDiagnostic(message: string, level: 'info' | 'error' = 'error'): void {
    if (this.closing || this.terminalRestored) return
    this.store.report(message, level)
  }

  private context(): UiContext {
    return {
      sessionId: this.info?.sessionId,
      attachmentId: this.info?.attachmentId,
      route: (this.info?.provider ?? '') + '/' + (this.info?.model ?? ''),
      editor: this.editor,
      epoch: this.epoch,
    }
  }

  /** True while a captured UI operation still belongs to the live attachment. */
  private sameContext(context: UiContext): boolean {
    return this.sameAttachment(context) && (this.info?.provider ?? '') + '/' + (this.info?.model ?? '') === context.route
  }

  /**
   * Attachment identity without the model route. Operations that intentionally
   * change the route (/model, /effort, /preset, /new, /resume) use this so their
   * own `ready` event is not mistaken for a stale result.
   */
  private sameAttachment(context: UiContext): boolean {
    return !this.closing && this.epoch === context.epoch &&
      this.info?.sessionId === context.sessionId &&
      this.info?.attachmentId === context.attachmentId &&
      this.editor === context.editor
  }

  /** Terminal focus is a pointer boundary, never an editor or native mode change. */
  private handleTerminalFocus(focused: boolean): void {
    if (this.closing || this.terminalRestored) return
    this.terminalPointerActive = focused
    if (!focused) this.transcript.releaseHover()
    this.syncOverlayMouse()
    this.render()
  }

  /**
   * Global routing for explicit Ctrl+C while a dialog, settings list or
   * history search owns focus. It never clears or rewrites local state: the
   * native cancel settles decisions and the backend reports the real outcome.
   */
  private globalInput(data: string): TuiInputListenerResult {
    if (this.closing || this.terminalPaused || this.dialog === undefined) return undefined
    if (this.editor.isPasting() || (this.dialog as Component & { isPasting?: boolean }).isPasting === true || data.startsWith('\x1b[200~')) return undefined
    if (!this.bound(data, 'app.interrupt')) return undefined
    if (this.decisionId === undefined && !this.isBusy) return undefined
    void this.interrupt()
    return { consume: true }
  }

  /**
   * Read-only queued human-input projection. Native inboxes also contain
   * context-only notices (for example permission changes), which are not
   * user messages waiting to send or recall. The adapter's queued count uses
   * the same eligibility as dequeue; pending remains the raw inbox count.
   * Cancellation retains input through DSH keepInbox, never a TUI scheduler.
   */
  private refreshQueue(): Promise<void> {
    const context = this.context()
    if (!this.connected || !this.info?.capabilities.includes('state')) {
      if (this.queued !== 0 || this.queueRows.length !== 0) {
        this.queued = 0
        this.queueRows = []
        this.editingQueueId = undefined
        this.render()
      }
      return Promise.resolve()
    }
    // A status refresh can sample the inbox before the driver claims the
    // message just sent. A later caller marks that read dirty so one more
    // snapshot runs after it, instead of keeping the unclaimed copy on screen.
    if (this.queueRequest?.epoch === context.epoch) {
      this.queueRequest.dirty = true
      return this.queueRequest.promise
    }
    const promise = (async () => {
      try {
        const state = object(await this.options.backend.command('state'))
        if (!this.sameContext(context) || !state) return
        const pending = object(state.pending)
        const nextTurn = typeof pending?.nextTurn === 'number' ? pending.nextTurn : 0
        const nextStep = typeof pending?.nextStep === 'number' ? pending.nextStep : 0
        // An explicit zero is authoritative even if native context is pending.
        const hasQueue = Array.isArray(state.queue)
        const rows = readQueueEntries(state.queue).filter(row => !this.admittedUserMessageIds.has(row.messageId))
        const queued = hasQueue
          ? rows.length
          : (typeof state.queued === 'number' ? state.queued : nextTurn + nextStep)
        const sameRows = sameQueue(this.queueRows, rows)
        const countChanged = queued !== this.queued
        this.queued = Math.max(0, queued)
        this.queueRows = rows
        const editingGone = this.editingQueueId !== undefined && !rows.some(row => row.messageId === this.editingQueueId)
        if (editingGone) this.editingQueueId = undefined
        if (!sameRows || countChanged || editingGone) this.render()
        this.applyUsage(object(state.usage))
        this.applyStats(object(state.stats))
      } catch { /* the queue is a read-only projection; a state failure is not a fatal backend error */ }
    })()
    this.queueRequest = { epoch: context.epoch, promise, dirty: false }
    void promise.finally(() => {
      if (this.queueRequest?.promise !== promise) return
      const dirty = this.queueRequest.dirty
      this.queueRequest = undefined
      if (dirty && this.sameContext(context)) void this.refreshQueue()
    })
    return promise
  }

  async start(): Promise<void> {
    if (this.started || this.closing) return
    this.started = true
    this.reloadKeys()
    this.configureEditor()
    this.slot.addChild(this.prompt)
    // Reuse the reserved separator row for the follow button. A renderer
    // overlay on the last transcript row would cover a thinking summary/body
    // and steal the next collapse click at the same pointer position.
    this.bottom.addChild({
      render: width => this.renderFollowIndicator(width),
      handleMouse: event => this.followHitboxes.handleMouse(event),
      invalidate: () => this.followHitboxes.clear(),
    })
    for (const item of [this.queueList, this.statusDockStack, this.slot, this.hint, this.footer]) this.bottom.addChild(item)
    // Only TranscriptView sees pointer motion inside its own box. The parent
    // releases that hover at the surrounding boundaries without clearing any
    // press pin, drag, selection, disclosure or editor state.
    const bottomMouse = this.bottom.handleMouse.bind(this.bottom)
    this.bottom.handleMouse = event => {
      this.transcript.releaseHover()
      return bottomMouse(event)
    }
    const document = new Container()
    document.addChild(this.welcome)
    // Keep the first conversation off the logo/identity block.
    document.addChild(new Spacer(1))
    document.addChild(this.transcript)
    const documentMouse = document.handleMouse.bind(document)
    document.handleMouse = event => {
      if (event.y < this.welcome.render(event.width).length + 1) this.transcript.releaseHover()
      return documentMouse(event)
    }
    const documentRender = document.render.bind(document)
    document.render = width => {
      const scrollTop = this.scrollView?.scrollTop
      if (scrollTop !== this.hoverScrollTop) {
        this.transcript.releaseHover()
        this.hoverScrollTop = scrollTop
      }
      return documentRender(width)
    }
    if (isViewportTUI(this.tui)) {
      this.scrollView = new ScrollView(document, { follow: 'end', primary: true })
      this.tui.setLayoutRoot(new VStack([
        { component: this.scrollView, basis: 0, grow: 1, minSize: 1 },
        { component: this.bottom, basis: 'auto', shrink: 1, minSize: 4 },
      ]))
    } else { this.tui.addChild(document); this.tui.addChild(this.bottom) }
    this.store.onChange = () => this.render()
    this.off = this.options.backend.onEvent(event => this.onEvent(event))
    this.offInput = this.tui.addInputListener(data => {
      const pasting = this.editor.isPasting() || (this.dialog as Component & { isPasting?: boolean } | undefined)?.isPasting === true
      // Real ProcessTerminal notifies before Pi consumes focus reports. Only
      // custom terminals without that public observer use this fallback.
      if (!this.tui.terminal.onFocusChange && !pasting && (data === '\x1b[O' || data === '\x1b[I')) {
        this.handleTerminalFocus(data === '\x1b[I')
      }
      if (this.terminalIntegration.handleInput(data, pasting)) return { consume: true }
      return this.globalInput(data)
    })
    this.tui.setFocus(this.prompt)
    this.syncTerminalPresentation()
    this.tui.start()
    this.terminalIntegration.start()
    this.applyDisplayPreferences(this.settings.get())
    if (this.options.registerSignals !== false) {
      const handlers: Array<[NodeJS.Signals, number]> = [['SIGINT', 130], ['SIGTERM', 0], ['SIGHUP', 0]]
      for (const [signal, code] of handlers) {
        const handler = () => { void this.shutdown(code) }
        process.on(signal, handler); this.signals.push([signal, handler])
      }
    }
    this.render()
    await this.watchKeys()
    // Read-only git observations for the footer: async, debounced and
    // refreshed periodically plus after each settled instruction.
    this.gitRefresher = createGitStatsRefresher({
      cwd: () => this.options.cwd,
      query: (cwd, signal) => readGitStats(cwd, signal),
      onChange: stats => {
        this.gitStats = stats
        this.render()
      },
    })
    this.gitRefresher.refresh()
    this.gitTimer = setInterval(() => this.gitRefresher?.refresh(), 10_000)
    this.gitTimer.unref()
    // The connect task starts before the overlay opens so the picker's async
    // listing can await it; the DSH runtime boots behind a visible dialog.
    this.connecting = this.options.backend.connect()
    if (this.options.resumePicker) this.openStartupSessionPicker()
    try {
      const info = await this.connecting
      if (this.closing) return
      this.applyInfo(info)
      // The picker's listing must not queue behind the command roster.
      if (this.options.resumePicker) void this.refreshCommands()
      else await this.refreshCommands()
      this.refreshQueue()
      void this.queryAutoTitle()
      for (const warning of [...this.warnings, ...this.settings.warnings, ...this.history.warnings]) this.store.report(warning, 'error')
      if (!this.options.resumePicker && this.options.initialPrompt) await this.submit(this.options.initialPrompt)
    } catch (error) {
      this.connected = false; this.fatal = true
      this.store.report('Could not start DSH: ' + errorText(error), 'error')
    }
    this.render()
  }

  private optionalUiCommands(): CommandCatalogEntry[] {
    const capabilities = this.info?.capabilities ?? []
    return OPTIONAL_UI_COMMANDS.filter(command =>
      (capabilities.includes(command.capability) || (command.name === 'inspect' && capabilities.includes('native-tools'))) &&
      !this.nativeCommands.some(native => native.name === command.name))
  }

  private isUiCommand(name: string): boolean {
    return UI_COMMAND_NAMES.has(name) || this.optionalUiCommands().some(command => command.name === name)
  }

  private commands(): CommandCatalogEntry[] {
    const commands: CommandCatalogEntry[] = [...UI_COMMANDS, ...this.optionalUiCommands()]
    const names = new Set(commands.map(command => command.name))
    for (const command of this.nativeCommands) if (!names.has(command.name)) { commands.push(command); names.add(command.name) }
    return commands
  }

  private updateAutocomplete(): void {
    const editor = this.editor
    const basePath = this.info?.cwd ?? this.options.cwd
    if (this.autocomplete?.editor === editor && this.autocomplete.basePath === basePath) return
    this.autocomplete?.provider.dispose()
    const provider = new NativeAutocompleteProvider({
      commands: () => this.commands(),
      // A child reply is plain child text, not a promise about the root's skill scope.
      skills: () => this.subagentReplyTarget === undefined && this.connected && this.skillCatalog?.available
        ? this.skillCatalog.entries : [],
      basePath,
      ...(this.options.backend.listFileReferences === undefined ? {} : {
        fileReferences: async (query: string, signal: AbortSignal) => {
          // Native file-reference discovery is root-Agent scoped. Never call
          // an unmounted capability or offer the root workspace while the same
          // editor is addressing a child.
          if (!this.info?.capabilities.includes('file-references') || this.subagentReplyTarget !== undefined) return []
          const context = this.context()
          try {
            const candidates = await this.options.backend.listFileReferences!(query, signal)
            return this.sameAttachment(context) && this.subagentReplyTarget === undefined ? candidates : []
          } catch {
            // DSH's candidate contract is intentionally quiet: an unavailable,
            // cancelled or failed domain contributes no rows and never types a
            // diagnostic into the prompt/transcript.
            return []
          }
        },
      }),
      refreshSkills: signal => {
        if (signal.aborted || this.subagentReplyTarget !== undefined) return Promise.resolve()
        this.rememberSkillAutocomplete(signal)
        return this.refreshSkills()
      },
    })
    this.autocomplete = { editor, basePath, provider }
    editor.setAutocompleteProvider(provider)
  }

  private refreshCommands(force = false): Promise<void> {
    if (this.closing) return Promise.resolve()
    const context = this.context()
    const sessionId = context.sessionId
    if (!sessionId || !this.info?.capabilities.includes('commands')) {
      this.catalogRequest = undefined
      this.nativeCommands = []; this.updateAutocomplete(); this.updateHelpCatalog(); return Promise.resolve()
    }
    if (!force && this.catalogRequest?.sessionId === sessionId && this.catalogRequest.attachmentId === context.attachmentId) return this.catalogRequest.promise
    // Request identity also protects overlapping Help refreshes in the same
    // attachment: an older listing must not replace the newer native roster.
    const request = { sessionId, attachmentId: context.attachmentId, dirty: false, promise: Promise.resolve() }
    this.catalogRequest = request
    request.promise = (async () => {
      try {
        const result = await this.options.backend.command('commands')
        if (!this.sameContext(context) || this.catalogRequest !== request || request.dirty) return
        this.nativeCommands = Array.isArray(result) ? result.flatMap(value => {
          const command = object(value)
          if (typeof command?.name !== 'string' || !command.name) return []
          const input = object(command.input)
          return [{
            name: command.name,
            description: typeof command.description === 'string' ? command.description : '',
            ...(typeof command.definitionId === 'string' ? { definitionId: command.definitionId } : {}),
            ...(typeof input?.hint === 'string' ? { inputHint: input.hint } : {}),
          }]
        }) : []
        this.updateAutocomplete()
        this.refreshSkillAutocomplete()
        this.updateHelpCatalog()
        this.render()
      } catch (error) {
        if (this.sameContext(context) && this.catalogRequest === request && !request.dirty) this.store.report('Could not read DSH commands: ' + errorText(error), 'error')
      } finally {
        if (this.catalogRequest === request) {
          this.catalogRequest = undefined
          // Many native registrations in one scope need only one trailing read.
          // Await it so a Help caller never builds from the invalidated result.
          if (request.dirty && this.sameContext(context)) await this.refreshCommands(true)
        }
      }
    })()
    return request.promise
  }

  private invalidateSkills(): void {
    this.skillRevision += 1
    this.skillCatalog = undefined
    this.skillsDirty = true
    if (this.skillsRequest !== undefined) this.skillsRequest.dirty = true
  }

  /** Single-flight native metadata observation. No menu/query materializes an Agent. */
  private refreshSkills(force = false): Promise<void> {
    if (this.closing || !this.connected || this.info?.capabilities.includes('skills') !== true) {
      this.skillCatalog = undefined
      this.skillsDirty = false
      return Promise.resolve()
    }
    if (force) this.invalidateSkills()
    const context = this.context()
    const current = this.skillsRequest
    if (current !== undefined && this.sameAttachment(current.context)) {
      // A native invalidation during discovery gets one trailing current-scope read.
      return current.dirty ? current.promise.then(() => this.refreshSkills()) : current.promise
    }
    if (!this.skillsDirty) return Promise.resolve()
    const request = { context, revision: this.skillRevision, dirty: false, promise: Promise.resolve() }
    this.skillsRequest = request
    this.skillsDirty = false
    request.promise = (async () => {
      try {
        const raw = await this.options.backend.command('skills')
        if (this.skillsRequest !== request || request.revision !== this.skillRevision || !this.sameAttachment(context)) return
        const snapshot = readSkillCatalog(raw)
        if (snapshot === undefined) throw new Error('DSH returned an invalid skill metadata envelope.')
        this.skillCatalog = snapshot
        // Unavailable/incomplete is not a permanent empty catalog. Retry on
        // the next actual menu query; never create an idle polling loop.
        this.skillsDirty = !snapshot.available || !snapshot.complete
        this.refreshSkillAutocomplete()
        this.updateHelpCatalog()
        this.render()
      } catch (error) {
        if (this.skillsRequest === request && request.revision === this.skillRevision && this.sameAttachment(context)) {
          this.skillsDirty = true
          this.store.report('Could not read DSH skills: ' + errorText(error), 'error')
        }
      } finally {
        if (this.skillsRequest === request) {
          this.skillsRequest = undefined
          if (request.dirty && this.sameAttachment(context)) void this.refreshSkills()
        }
      }
    })()
    return request.promise
  }

  private skillAutocompletePrefix(): boolean {
    return this.editor.focused && !this.editor.isPasting() && this.dialog === undefined &&
      !this.terminalPaused && this.subagentReplyTarget === undefined && /^\/[a-zA-Z0-9-]*$/.test(this.editor.getText())
  }

  private rememberSkillAutocomplete(signal?: AbortSignal): void {
    if (signal?.aborted || !this.skillAutocompletePrefix()) return
    this.skillAutocompleteIntent = {
      context: this.context(), surface: this.surfaceGeneration,
      generation: this.inputGeneration, text: this.editor.getText(),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  /** Re-query Pi without accepting a candidate, moving the cursor or changing undo/draft state. */
  private refreshSkillAutocomplete(): void {
    const intent = this.skillAutocompleteIntent
    this.skillAutocompleteIntent = undefined
    if (intent === undefined || intent.signal?.aborted || !this.sameAttachment(intent.context) ||
      intent.surface !== this.surfaceGeneration || intent.generation !== this.inputGeneration ||
      intent.text !== this.editor.getText() || !this.skillAutocompletePrefix()) return
    this.editor.ccRefreshAutocomplete()
  }

  private skillPromptCandidate(text: string): boolean {
    const name = leadingSkillGestureName(text)
    return name !== undefined && !this.isUiCommand(name) && this.connected &&
      this.info?.capabilities.includes('skills') === true
  }

  /** Native scope is consulted only after an explicit submission, so first-input commands win too. */
  private async isSkillPrompt(text: string, context: UiContext, hasAttachments = false): Promise<boolean | undefined> {
    const name = leadingSkillGestureName(text)
    if (name === undefined || !this.skillPromptCandidate(text)) return false
    if (this.info?.capabilities.includes('input-route')) {
      // The submission-time lookup may create the pending native scope. Do not
      // do that for an image when its native admission service is not mounted.
      if (hasAttachments && !this.info.capabilities.includes('prompt-content')) {
        throw new Error('This runtime has no native attachment prompt admission; your draft was kept.')
      }
      const raw = object(await this.options.backend.command('input-route', { name }))
      if (!this.sameAttachment(context)) return undefined
      if ((raw?.kind !== 'command' && raw?.kind !== 'prompt') || typeof raw.sessionId !== 'string' ||
        (raw.attachmentId !== undefined && typeof raw.attachmentId !== 'string')) {
        throw new Error('DSH returned an invalid native input route.')
      }
      if (raw.sessionId !== this.info?.sessionId || raw.attachmentId !== this.info?.attachmentId) return undefined
      return raw.kind === 'prompt'
    }
    // Smaller/fixture backends can expose an already-readable catalog without a native pending scope.
    await this.refreshSkills()
    if (!this.sameAttachment(context)) return undefined
    if (this.nativeCommands.some(command => command.name === name)) return false
    return this.skillCatalog?.available === true && this.skillCatalog.entries.some(skill => skill.name === name)
  }

  /** Display-only grouping of the current native metadata; never a command registry. */
  private helpCatalog(): { commands: HelpCommand[]; customCommands: HelpCommand[]; skills: SkillCatalogSnapshot; note?: string } {
    const localNames = new Set([...UI_COMMANDS, ...this.optionalUiCommands()].map(command => command.name))
    const commands: HelpCommand[] = []
    const customCommands: HelpCommand[] = []
    for (const command of this.commands()) {
      // DSH has no builtin/custom marker. This is a display convention based
      // on native plugin-namespaced identity, not verified ownership. Missing
      // identity is grouped with custom/other registrations; no names are guessed.
      const group = localNames.has(command.name) || command.definitionId?.startsWith('@deepseek-ai/')
        ? commands : customCommands
      group.push(command)
    }
    return {
      commands, customCommands,
      // Missing capability must remain visible as unavailable, not silently
      // erase the section and leave the user unable to distinguish failures.
      skills: this.skillCatalog ?? { entries: [], available: false, complete: false },
      ...(customCommands.length ? { note: 'Custom commands includes plugin and unattributed native registrations.' } : {}),
    }
  }

  private updateHelpCatalog(): void {
    if (this.dialog instanceof HelpPanel) this.dialog.setCatalog(this.helpCatalog())
  }

  /** Read-only command discovery; Help never changes the prompt or runs a command. */
  private async openHelp(): Promise<void> {
    const context = this.context()
    const surface = this.surfaceGeneration
    await Promise.all([this.refreshCommands(true), this.refreshSkills(true)])
    if (!this.sameContext(context) || surface !== this.surfaceGeneration) return
    this.showDialog(new HelpPanel(this.tui, {
      ...this.helpCatalog(), keymap: this.keymap,
      onClose: () => { this.dismissDialog(); this.returnToSettings() },
      onInterrupt: () => { if (this.isBusy) void this.interrupt(); else { this.dismissDialog(); this.returnToSettings() } },
    }))
  }

  /** Display-only key labels for transcript hints; no fixed key name is invented. */
  private viewHints(): TranscriptViewHints {
    return transcriptHints(this.keymap)
  }

  /** One native call, one read-only interaction; it never executes or fills a prompt. */
  private openToolDetails(request?: ToolDetailsRequest): void {
    if (this.closing || this.terminalPaused || this.dialog !== undefined || this.decisions.length > 0) return
    const tool = request === undefined
      ? [...this.store.items].reverse().find(item => item.kind === 'tool')
      : this.store.items.find(item => item.kind === 'tool' && item.callId === request.callId)
    if (tool?.kind !== 'tool') {
      if (request === undefined) this.store.report('No tool calls to inspect.')
      return
    }
    this.closeImageDetails()
    this.closeToolDetails()
    this.closeSubagentSurfaces()
    this.keymap.cancelChord()
    this.chordHint = undefined
    this.exitArm = undefined
    this.surfaceGeneration += 1
    const tui = this.tui
    const selected: ToolDetailsRequest = request ?? { callId: tool.callId, section: 'output' }
    const dialog = new ToolDetailsDialog(tui, {
      tool, section: selected.section, keymap: this.keymap,
      get maxHeight() { return modalHeight(tui, 'wide') },
      getToolNavigation: () => this.toolDetailsNavigation(selected.callId),
      getTools: () => this.store.items.filter(item => item.kind === 'tool'),
      onSelectTool: callId => this.selectToolDetails(callId),
      onPreviousTool: () => { this.navigateToolDetails(-1) },
      onNextTool: () => { this.navigateToolDetails(1) },
      onImageDetails: request => this.openImageDetails(request),
      onClose: () => { if (this.toolDetailsOverlay?.dialog === dialog) this.closeToolDetails() },
      onInterrupt: () => {
        if (this.toolDetailsOverlay?.dialog !== dialog) return
        this.closeToolDetails()
        if (this.isBusy) void this.interrupt()
      },
      onCopy: async text => {
        if (this.options.copyText !== undefined) { await this.options.copyText(text); return }
        const clipboard = getNativeClipboard()
        if (clipboard?.setText === undefined) throw new Error('Native clipboard unavailable in this terminal.')
        await clipboard.setText(text)
      },
      onRenderRequest: () => { this.tui.requestRender() },
    })
    const handle = tui.showOverlay(dialog, modalOverlayOptions('wide'))
    this.toolDetailsOverlay = { request: selected, dialog, handle }
    this.viewOptions.mouseBlocked = true
    this.render()
  }

  private closeToolDetails(): void {
    const overlay = this.toolDetailsOverlay
    if (overlay === undefined) return
    this.toolDetailsOverlay = undefined
    this.syncOverlayMouse()
    this.surfaceGeneration += 1
    overlay.handle.hide()
    overlay.dialog.dispose()
    this.tui.requestRender()
  }

  private toolDetailsNavigation(fallbackCallId: string): { index: number; total: number } {
    const tools = this.store.items.filter(item => item.kind === 'tool')
    const callId = this.toolDetailsOverlay?.request.callId ?? fallbackCallId
    return { index: Math.max(0, tools.findIndex(item => item.callId === callId)), total: tools.length }
  }

  private selectToolDetails(callId: string): void {
    const overlay = this.toolDetailsOverlay
    if (overlay === undefined || overlay.request.callId === callId) return
    const tool = this.store.items.find(item => item.kind === 'tool' && item.callId === callId)
    if (tool?.kind !== 'tool') return
    overlay.request = { callId, section: overlay.dialog.section }
    overlay.dialog.setTool(tool)
    this.tui.requestRender()
  }

  /** Navigate declared calls, never completion order or a TUI-owned session policy. */
  private navigateToolDetails(direction: -1 | 1): void {
    const overlay = this.toolDetailsOverlay
    if (overlay === undefined) return
    const tools = this.store.items.filter(item => item.kind === 'tool')
    const index = tools.findIndex(item => item.callId === overlay.request.callId)
    if (index < 0) { this.closeToolDetails(); return }
    const next = tools[index + direction]
    if (next === undefined) return
    overlay.request = { callId: next.callId, section: overlay.dialog.section }
    overlay.dialog.setTool(next)
    this.tui.requestRender()
  }

  /** Refresh the same panel, or remove it when its call/session disappears. */
  private syncToolDetails(): void {
    const overlay = this.toolDetailsOverlay
    if (overlay === undefined) return
    const tool = this.store.items.find(item => item.kind === 'tool' && item.callId === overlay.request.callId)
    if (tool?.kind !== 'tool') this.closeToolDetails()
    else overlay.dialog.setTool(tool)
  }

  /** Ordered image occurrences, not a newest-session policy or attachment-id deduplication. */
  private imageDetailsItems(): ImageViewItem[] {
    return [
      ...getTranscriptImages(this.store.items),
      ...(this.queuedAttachmentRecoveries.get(this.info?.sessionId ?? '') ?? []).flatMap((message, index) =>
        message.content.flatMap((part, partIndex) => part.type === 'image' ? [{
          key: `queued:${this.info?.sessionId}:${message.messageId ?? index}:image-${partIndex}`,
          label: `Retrieved queued image ${index + 1}`,
          attachment: part.attachment,
        }] : [])),
      ...this.editor.getImageAttachments().map(({ id, image }, index) => ({
        key: `draft:${this.epoch}:image-${id}:${index}`,
        label: `Draft image ${index + 1}`,
        upload: image,
      })),
    ]
  }

  private openImageDetails(request?: ImageDetailsRequest): void {
    if (this.closing || this.terminalPaused || this.dialog !== undefined || this.decisions.length > 0) return
    const images = this.imageDetailsItems()
    const image = request === undefined ? images.at(-1) : images.find(item => item.key === request.key)
    if (image === undefined) {
      if (request === undefined) this.store.report('No images to inspect in this session.')
      return
    }
    this.closeImageDetails()
    this.closeSubagentSurfaces()
    this.keymap.cancelChord(); this.chordHint = undefined; this.exitArm = undefined
    this.surfaceGeneration += 1
    const selected: ImageDetailsRequest = { key: image.key }
    const tui = this.tui
    const dialog = new ImageDetailsDialog(tui, {
      image, keymap: this.keymap, preview: this.settings.get().imagePreview,
      setPreview: value => {
        if ((this.imagePreviewIntent === undefined && this.settings.get().imagePreview === value) || this.imagePreviewIntent === value) return
        this.imagePreviewIntent = value
        const generation = ++this.imagePreviewGeneration
        void this.settings.set({ imagePreview: value }).then(() => {
          if (generation !== this.imagePreviewGeneration) return
          this.imagePreviewIntent = undefined
          if (!this.closing) this.applyDisplayPreferences(this.settings.get())
        }).catch(error => {
          if (generation !== this.imagePreviewGeneration) return
          this.imagePreviewIntent = undefined
          if (this.imageDetailsOverlay?.dialog === dialog) dialog.setPreview(this.settings.get().imagePreview)
          if (!this.closing) this.store.report('Image preview preference was not saved: ' + errorText(error), 'error')
        })
      },
      readImage: async (attachment, signal) => {
        const read = this.options.backend.readImage
        if (read === undefined) throw new Error('Image attachments are unavailable in this backend.')
        return imageAttachmentValue(await read.call(this.options.backend, attachment, signal), attachment)
      },
      get maxHeight() { return modalHeight(tui, 'wide') },
      getImageNavigation: () => this.imageDetailsNavigation(selected.key),
      onPreviousImage: () => { this.navigateImageDetails(-1) },
      onNextImage: () => { this.navigateImageDetails(1) },
      onClose: () => { if (this.imageDetailsOverlay?.dialog === dialog) this.closeImageDetails() },
      onInterrupt: () => {
        if (this.imageDetailsOverlay?.dialog !== dialog) return
        this.closeImageDetails()
        if (this.isBusy) void this.interrupt()
      },
      onRenderRequest: () => { if (!this.closing) this.tui.requestRender() },
    })
    // The viewer measures its own inner graphics viewport; the shared frame
    // preserves APC transfers rather than treating them as ordinary text.
    const handle = tui.showOverlay(dialog, modalOverlayOptions('wide'))
    this.imageDetailsOverlay = { request: selected, dialog, handle }
    this.viewOptions.mouseBlocked = true
    this.render()
  }

  private closeImageDetails(): void {
    const overlay = this.imageDetailsOverlay
    if (overlay === undefined) return
    this.imageDetailsOverlay = undefined
    this.syncOverlayMouse()
    this.surfaceGeneration += 1
    overlay.handle.hide()
    overlay.dialog.dispose()
    this.tui.requestRender()
  }

  private imageDetailsNavigation(fallbackKey: string): { index: number; total: number } {
    const images = this.imageDetailsItems()
    const key = this.imageDetailsOverlay?.request.key ?? fallbackKey
    return { index: Math.max(0, images.findIndex(image => image.key === key)), total: images.length }
  }

  private navigateImageDetails(direction: -1 | 1): void {
    const overlay = this.imageDetailsOverlay
    if (overlay === undefined) return
    const images = this.imageDetailsItems()
    const index = images.findIndex(image => image.key === overlay.request.key)
    if (index < 0) { this.closeImageDetails(); return }
    const image = images[index + direction]
    if (image === undefined) return
    overlay.request = { key: image.key }
    overlay.dialog.setImage(image)
    this.tui.requestRender()
  }

  private syncImageDetails(): void {
    const overlay = this.imageDetailsOverlay
    if (overlay === undefined) return
    const image = this.imageDetailsItems().find(item => item.key === overlay.request.key)
    if (image === undefined) this.closeImageDetails()
    else overlay.dialog.setImage(image)
  }

  // ------------------------------------------------------------- subagents

  private syncOverlayMouse(): void {
    this.viewOptions.mouseBlocked = !this.terminalPointerActive || this.dialogOverlay !== undefined || this.toolDetailsOverlay !== undefined ||
      this.imageDetailsOverlay !== undefined || this.agentsOverlay !== undefined ||
      this.childSessionOverlay !== undefined
  }

  private openAgentsOverlay(initialState?: AgentsViewState): void {
    if (this.closing || this.terminalPaused || this.dialog !== undefined || this.decisions.length > 0) return
    if (this.store.subagentEntries.length === 0) {
      this.store.report('No native subagents in this session.')
      return
    }
    this.closeImageDetails()
    this.closeToolDetails()
    this.closeSubagentSurfaces()
    this.keymap.cancelChord(); this.chordHint = undefined; this.exitArm = undefined
    this.surfaceGeneration += 1
    const dialog = new AgentsOverlay(this.tui, {
      entries: this.store.subagentEntries, initialState,
      ...(this.store.subagentsTruncated ? { truncated: true } : {}),
      keymap: this.keymap,
      maxHeight: modalHeight(this.tui, 'standard'),
      onClose: () => this.closeAgentsOverlay(),
      onOpen: entry => { void this.openSubagentSession(entry.id, true) },
      ...(this.info?.capabilities.includes('subagent-prompt') === true
        ? { onReply: (entry: SubagentEntry) => this.beginSubagentReply(entry) } : {}),
      ...(this.info?.capabilities.includes('subagent-interrupt') === true
        ? { onStop: (entry: SubagentEntry) => { void this.interruptSubagent(entry) } } : {}),
      onInterrupt: () => this.closeAgentsOverlay(),
      onGlobalAction: id => this.handleSubagentGlobalAction(id),
      onRenderRequest: () => this.render(),
    })
    const handle = this.tui.showOverlay(dialog, modalOverlayOptions('standard'))
    this.agentsOverlay = { dialog, handle }
    this.syncOverlayMouse()
    this.render()
  }

  private closeAgentsOverlay(): void {
    const overlay = this.agentsOverlay
    if (overlay === undefined) return
    this.agentsOverlay = undefined
    this.surfaceGeneration += 1
    overlay.handle.hide()
    overlay.dialog.dispose()
    this.syncOverlayMouse()
    this.tui.requestRender()
  }

  private async openSubagentSession(childId: string, returnToList = false): Promise<void> {
    if (this.closing || this.terminalPaused || this.dialog !== undefined || this.decisions.length > 0) return
    // An already open/loading child owns this navigation. Repeated activation
    // must not restart reads or release the same native follow underneath it.
    if (this.childSessionOverlay?.childId === childId) return
    const entry = this.store.subagentEntry(childId)
    if (entry === undefined) {
      this.store.report('The native subagent is not present in this session.', 'error')
      return
    }
    if (entry.mode === 'external' || entry.status === 'external' || entry.local === false) {
      this.store.report('External subagents have no local transcript to display.')
      return
    }
    const context = this.context()
    const rootSessionId = context.sessionId
    if (rootSessionId === undefined) return
    const returnState = returnToList ? this.agentsOverlay?.dialog.captureView() : undefined
    this.closeImageDetails()
    this.closeToolDetails()
    this.closeSubagentSurfaces()
    this.keymap.cancelChord(); this.chordHint = undefined; this.exitArm = undefined
    this.surfaceGeneration += 1
    const surface = this.surfaceGeneration
    const pending: NonNullable<App['pendingChildFollow']> = { childId, surface, events: [], overflow: false }
    const childStore = new TranscriptStore()
    const codec = this.options.backend.transcriptCodec
    if (codec !== undefined) childStore.setCodec(codec)
    const view = new TranscriptView(childStore, {
      ...this.viewOptions,
      suppressLiveTodos: false,
      mouseBlocked: false,
      onToolDetails: undefined,
      onImageDetails: undefined,
      onViewportAnchor: undefined,
      onSubagentDetails: id => { void this.openSubagentSession(id) },
    })
    // Navigation is synchronous; only the transcript waits for native reads.
    // The catalog entry is real, and no placeholder SessionInfo/Agent is made.
    const dialog = new ChildSessionView(this.tui, {
      entry,
      loading: true,
      store: childStore,
      view,
      keymap: this.keymap,
      breadcrumb: [rootSessionId, entry.label ?? childId],
      onClose: () => this.closeChildSession(),
      ...(this.info?.capabilities.includes('subagent-prompt') === true
        ? { onReply: (current: SubagentEntry) => this.beginSubagentReply(current) } : {}),
      ...(this.info?.capabilities.includes('subagent-interrupt') === true
        ? { onStop: (current: SubagentEntry) => { void this.interruptSubagent(current) } } : {}),
      onInterrupt: () => this.closeChildSession(),
      onGlobalAction: id => this.handleSubagentGlobalAction(id),
      onRenderRequest: () => this.render(),
    })
    childStore.onChange = () => { dialog.invalidate(); this.render() }
    const handle = this.tui.showOverlay(dialog, modalOverlayOptions('wide'))
    const overlay: NonNullable<App['childSessionOverlay']> = { childId, context, store: childStore, dialog, handle, returnToList, returnState }
    this.childSessionOverlay = overlay
    this.pendingChildFollow = pending
    const ownsSurface = () => this.childSessionOverlay === overlay && surface === this.surfaceGeneration && this.sameAttachment(context)
    const current = () => ownsSurface() && this.pendingChildFollow === pending
    this.syncOverlayMouse()
    this.render()
    try {
      await this.options.backend.command('subagent-follow', { sessionId: childId, follow: true })
      if (!current()) { this.releaseUnownedChildFollow(childId, context); return }
      const raw = await this.options.backend.command('subagent-session', { sessionId: childId })
      if (!current()) { this.releaseUnownedChildFollow(childId, context); return }
      if (pending.overflow) throw new Error('the live child event buffer was exceeded; reopen the child session')
      const info = object(raw)
      if (info?.sessionId !== childId) throw new Error('DSH returned an invalid child session snapshot')
      const childInfo = info as unknown as SessionInfo
      overlay.info = childInfo
      this.pendingChildFollow = undefined
      childStore.reset(childInfo)
      dialog.update({ info: childInfo })
      for (const event of pending.events) this.routeChildEvent(event)
      dialog.setLoading(false)
      this.render()
    } catch (error) {
      if (ownsSurface()) {
        this.closeChildSession(false)
        if (returnToList) {
          this.openAgentsOverlay(returnState)
          this.agentsOverlay?.dialog.setMessage('Could not open the child session: ' + errorText(error), true)
        }
        this.store.report('Could not open the child session: ' + errorText(error), 'error')
        this.render()
      } else this.releaseUnownedChildFollow(childId, context)
    }
  }

  /** A stale read/ack may release only its own attachment's unowned follow. */
  private releaseUnownedChildFollow(childId: string, context: UiContext): void {
    if (!this.sameAttachment(context) || this.childSessionOverlay?.childId === childId || this.pendingChildFollow?.childId === childId) return
    void this.options.backend.command('subagent-follow', { sessionId: childId, follow: false }).catch(() => {})
  }

  private beginSubagentReply(entry: SubagentEntry): void {
    const rootSessionId = this.info?.sessionId
    if (this.closing || rootSessionId === undefined) return
    if (this.editingQueueId !== undefined) {
      this.store.report('Finish or leave the queued-message edit before replying to a subagent.')
      this.render()
      return
    }
    if (this.info?.capabilities.includes('subagent-prompt') !== true || !subagentCanReply(entry)) {
      this.store.report('This native subagent cannot receive a continuable reply.', 'error')
      this.render()
      return
    }
    const current = this.store.subagentEntry(entry.id)
    if (current === undefined || current.parentSessionId !== entry.parentSessionId || !subagentCanReply(current)) {
      this.store.report('The native subagent is no longer present in this session.', 'error')
      this.render()
      return
    }
    // Keep the exact draft and its image registry. Only the submit destination
    // changes; no second Editor or overlay composer is created.
    this.closeSubagentSurfaces()
    this.subagentReplyTarget = {
      rootSessionId,
      childId: current.id,
      parentSessionId: current.parentSessionId,
      label: subagentLabel(current),
    }
    this.nextSendMode = undefined
    this.skillAutocompleteIntent = undefined
    this.editor.ccCancelAutocomplete()
    this.tui.setFocus(this.prompt)
    this.render()
  }

  private clearSubagentReplyTarget(): void {
    if (this.subagentReplyTarget !== undefined) this.editor.ccCancelAutocomplete()
    this.subagentReplyTarget = undefined
    this.nextSendMode = undefined
    this.skillAutocompleteIntent = undefined
  }

  private syncSubagentReplyTarget(): void {
    const target = this.subagentReplyTarget
    if (target === undefined) return
    const entry = this.store.subagentEntry(target.childId)
    if (this.info?.sessionId !== target.rootSessionId ||
      this.info.capabilities.includes('subagent-prompt') !== true ||
      entry === undefined || entry.parentSessionId !== target.parentSessionId || !subagentCanReply(entry)) {
      this.clearSubagentReplyTarget()
    }
  }

  private canStopSubagent(entry: SubagentEntry | undefined): entry is SubagentEntry {
    return entry !== undefined && subagentCanStop(entry) &&
      this.info?.capabilities.includes('subagent-interrupt') === true
  }

  private async interruptSubagent(entry: SubagentEntry): Promise<void> {
    const current = this.store.subagentEntry(entry.id)
    if (!this.canStopSubagent(current)) return
    const rootSessionId = this.info?.sessionId
    if (rootSessionId === undefined) return
    const key = rootSessionId + ':' + current.id
    if (this.pendingSubagentStops.has(key)) return
    const context = this.context()
    const label = subagentLabel(current)
    this.pendingSubagentStops.add(key)
    try {
      const receipt = object(await this.options.backend.command('subagent-interrupt', { sessionId: current.id }))
      if (receipt?.accepted !== true) throw new Error('DSH returned an invalid subagent interrupt receipt')
      if (this.sameAttachment(context)) {
        this.store.report('Interrupt admitted for ' + label + '; waiting for the native status to settle.')
      }
    } catch (error) {
      if (this.sameAttachment(context)) {
        const message = 'Could not interrupt ' + label + ': ' + errorText(error)
        this.agentsOverlay?.dialog.setMessage(message, true)
        this.childSessionOverlay?.dialog.setMessage(message, true)
        this.store.report(message, 'error')
      }
    } finally {
      this.pendingSubagentStops.delete(key)
      if (this.sameAttachment(context)) this.render()
    }
  }

  private closeChildSession(returnToList = true): void {
    const overlay = this.childSessionOverlay
    if (overlay === undefined) return
    this.childSessionOverlay = undefined
    if (this.pendingChildFollow?.childId === overlay.childId) this.pendingChildFollow = undefined
    this.surfaceGeneration += 1
    overlay.handle.hide()
    overlay.dialog.dispose()
    this.releaseUnownedChildFollow(overlay.childId, overlay.context)
    this.syncOverlayMouse()
    if (returnToList && overlay.returnToList && !this.closing) this.openAgentsOverlay(overlay.returnState)
    else this.tui.requestRender()
  }

  private closeSubagentSurfaces(): void {
    // A pending read belongs to the same immediately visible child surface.
    // Bulk teardown must not transiently reopen Agents between the two hides.
    this.closeChildSession(false)
    this.pendingChildFollow = undefined
    this.closeAgentsOverlay()
    this.syncOverlayMouse()
  }

  private syncSubagentSurfaces(): void {
    const agents = this.agentsOverlay
    if (agents !== undefined) {
      agents.dialog.setSnapshot({
        entries: this.store.subagentEntries,
        ...(this.store.subagentsTruncated ? { truncated: true } : {}),
      })
    }
    const child = this.childSessionOverlay
    if (child !== undefined) {
      const entry = this.store.subagentEntry(child.childId)
      if (entry === undefined || entry.mode === 'external' || entry.status === 'external' || entry.local === false) {
        this.closeChildSession(false)
        return
      }
      // Settlement refreshes the header, not the user's open conversation.
      // ChildSessionView.setEntry invalidates synchronously. Only call it for
      // a real projection replacement, not on every App.render recursion.
      if (entry !== child.dialog.entry) child.dialog.setEntry(entry)
    }
  }

  private routeChildEvent(event: BackendEvent): void {
    if (!('sessionId' in event)) return
    if (event.type !== 'session_event' && event.type !== 'status' &&
      event.type !== 'stream_start' && event.type !== 'stream_chunk' && event.type !== 'stream_end') return
    const pending = this.pendingChildFollow
    if (pending !== undefined && event.sessionId === pending.childId) {
      if (pending.events.length >= 1024) pending.overflow = true
      else pending.events.push(event)
      return
    }
    const overlay = this.childSessionOverlay
    if (overlay !== undefined && event.sessionId === overlay.childId) overlay.store.handle(event)
  }

  private handleSubagentGlobalAction(id: string): void {
    if (id !== 'app.exit') return
    // Keep the root editor's normal empty-draft/double-press exit policy.
    if (this.editor.getExpandedText().length > 0) return
    this.armExit(id)
    this.render()
  }

  /**
   * keepViewportOnExpand: a click that expands a thinking summary first
   * freezes follow-end so content growth cannot drag the viewport to the
   * bottom (the clicked row would jump away from under the pointer and the
   * collapse click would miss the hitbox). The collapsing click restores
   * follow only when the user has not scrolled away in the meantime.
   */
  private anchorTranscriptViewport(expanding: boolean): void {
    const view = this.scrollView
    if (view === undefined) return
    if (expanding) {
      if (!view.isFollowingEnd) return
      this.anchoredScrollTop = view.scrollTop
      view.scrollTo(view.scrollTop, { disableFollow: true })
      return
    }
    // The callback runs before the state flip. Keep the original anchor while
    // other thinking/tool disclosures remain open; count visible roots, not
    // the individual children of an expanded group.
    if (this.transcript.expandedDisclosureCount > 1) return
    const frozenAt = this.anchoredScrollTop
    this.anchoredScrollTop = null
    if (frozenAt !== null && !view.isFollowingEnd && view.scrollTop === frozenAt) view.scrollToEnd()
  }

  /** One fixed row outside the scroll host: never obscures transcript text. */
  private renderFollowIndicator(width: number): string[] {
    const view = this.scrollView
    if (view === undefined || view.isFollowingEnd) {
      this.followHitboxes.sync([])
      return ['']
    }
    const label = truncateToWidth(' ↓ Back to bottom · click to follow ', width, '')
    const labelWidth = visibleWidth(label)
    const startCol = Math.max(0, Math.floor((width - labelWidth) / 2))
    this.followHitboxes.sync(labelWidth === 0 ? [] : [{
      id: 'transcript-follow', startRow: 0, endRow: 0,
      startCol, endCol: startCol + labelWidth - 1,
      onClick: () => {
        this.anchoredScrollTop = null
        view.scrollToEnd()
        this.render()
      },
    }])
    return [' '.repeat(startCol) + accent(label)]
  }

  private configureEditor(): void {
    for (const text of this.history.entries()) this.editor.addToHistory(text)
    this.updateAutocomplete()
    this.editor.onChange = () => {
      if (!this.updatingDraft && this.restored && this.editor.getExpandedText() !== this.restored.text) this.restored = undefined
      if (this.skillAutocompleteIntent !== undefined) {
        const signal = this.skillAutocompleteIntent.signal
        this.skillAutocompleteIntent = undefined
        this.rememberSkillAutocomplete(signal)
      }
      this.exitArm = undefined
      this.render()
    }
    this.editor.onSubmit = text => { const mode = this.nextSendMode ?? 'followup'; this.nextSendMode = undefined; void this.submit(text, mode) }
    this.editor.onSubmitContent = payload => {
      const mode = this.nextSendMode ?? 'followup'; this.nextSendMode = undefined
      void this.submit(payload.text, mode, payload)
    }
    this.editor.onSubmitBlocked = error => {
      this.nextSendMode = undefined
      this.store.report('Prompt not accepted: ' + errorText(error), 'error')
      this.render()
    }
    this.editor.onAction = event => this.dispatchAction(event)
    this.editor.onChordChange = prefix => { this.chordHint = prefix ?? undefined; this.render() }
    this.prompt.onKey = data => this.beforeInput(data)
    this.prompt.focused = this.prompt.focused
  }

  private applyInfo(info: SessionInfo): void {
    this.infoStamp += 1
    const codec = this.options.backend.transcriptCodec
    if (codec && codec !== this.codec) { this.store.setCodec(codec); this.codec = codec }
    const changed = this.info?.sessionId !== info.sessionId || this.info?.attachmentId !== info.attachmentId
    // The first info lands while the startup resume overlay may already be
    // open; there is no previous session to tear stale surfaces down from.
    const replacedSession = this.info !== undefined
    this.info = info; this.connected = true; this.fatal = false
    if (info.title !== undefined) this.sessionTitles.set(info.sessionId, info.title)
    this.invalidateSkills()
    if (changed) {
      if (replacedSession) { this.settingsReturnState = undefined; this.settingsFeedback = undefined }
      this.skillsRequest = undefined
      this.skillAutocompleteIntent = undefined
      this.clipboardGeneration += 1; this.clipboardPending = false
      this.queueReadController?.abort(); this.queueReadController = undefined
      this.closeImageDetails()
      this.closeToolDetails()
      this.closeSubagentSurfaces()
      this.clearSubagentReplyTarget()
      resetImageDisplayCache()
      clearToolExpansion()
      this.anchoredScrollTop = null
      this.followHitboxes.clear()
      this.statusDockStack.invalidate()
      // Invalidate every asynchronous UI operation bound to the old attachment.
      this.epoch += 1
      this.nativeUi.reset()
      this.fileAttachController?.abort(); this.fileAttachController = undefined
      this.queueRequest = undefined
      this.queued = 0
      this.queueRows = []
      this.queueRemovals.clear()
      this.admittedUserMessageIds.clear()
      this.editingQueueId = undefined
      this.queueList.invalidate()
      this.nextPreset = undefined
      this.decisions.length = 0; this.activeCommands.clear(); this.nativeCommands = []
      this.todos = null
      this.todoBoard.todos = null; this.todoBoard.visible = true
      this.goalProgress.status = undefined
      this.planActive = undefined
      if (replacedSession) {
        const oldDialog = this.dialog
        this.hideDialog()
        disposeComponent(oldDialog)
        this.busy = false; this.stopSpinner(); this.output.reset()
        // Native projections belong to the session that produced them: never
        // carry the previous session's chips into the resumed/pending one.
        // (`applyUsage(undefined)` keeps the last value, so clear explicitly.)
        this.usage = undefined; this.stats = undefined
      }
      this.store.reset(info)
      if (info.truncated) this.store.report('Showing recent history only (' + (info.events?.length ?? 0) + '/' + (info.totalEvents ?? '?') + ' events); the full DSH log remains intact.')
      this.stashed = undefined; this.cleared = undefined; this.restored = undefined
      let history = this.histories.get(info.cwd)
      if (!history) { history = new PromptHistory(info.cwd, this.directory); this.histories.set(info.cwd, history) }
      this.history = history
      const oldEditor = this.editor
      this.prompt.editor = new PromptEditor(this.tui, editorTheme, { paddingX: 2, keymap: this.keymap })
      disposeComponent(oldEditor)
      this.configureEditor()
      void this.refreshCommands()
      void this.refreshQueue()
    } else {
      // Same attachment, new native facts: a pending session just materialized
      // (the roster gains preset-scoped commands) or DSH reconciled a reload.
      // Re-read the native command roster without invalidating live UI work.
      void this.refreshCommands(true)
    }
    if (!changed && this.editor.isShowingAutocomplete() && this.skillAutocompletePrefix()) {
      this.rememberSkillAutocomplete()
      this.editor.ccRefreshAutocomplete()
    }
    void this.refreshSkills()
    this.nativeUi.attached()
    this.render()
  }

  /**
   * Surface native plan-mode transitions; the projection is the authority.
   * The first snapshot also reports (a resumed plan-mode session announces
   * its state); repeated identical snapshots stay quiet.
   */
  private applyPlanSnapshot(value: { active: boolean } | null): void {
    const active = value?.active === true
    if (this.planActive === active) return
    this.planActive = active
    this.store.report(active ? 'Plan mode is active.' : 'Plan mode is off.')
  }

  /** CC Ctrl+T: toggle the live dock, never append a checklist to history. */
  private toggleTodos(): void {
    this.todoBoard.todos = this.todos
    // Empty and retired all-completed trays have no visible toggle effect.
    if (this.todoBoard.counts.total === 0 || !this.todoBoard.hasOpenItems) return
    this.todoBoard.toggle()
    this.render()
  }

  private onEvent(event: BackendEvent): void {
    if (this.closing) return
    if (event.type === 'ready') { this.applyInfo(event.info); this.terminalIntegration.observe(event); return }
    if (event.type === 'native_ui_changed') { this.nativeUi.invalidate(event); return }
    if (event.type === 'todos' && (event.sessionId !== this.info?.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== this.info?.attachmentId))) return
    if (event.type === 'title') {
      const info = this.info
      if (info === undefined || event.sessionId !== info.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== info.attachmentId)) return
      info.title = event.value
      this.sessionTitles.set(event.sessionId, event.value)
      if (this.dialog instanceof SessionPickerDialog) this.dialog.setTitles(new Map([[event.sessionId, event.value]]))
      this.render()
      return
    }
    if (event.type === 'model_route') {
      const info = this.info
      if (info === undefined || event.sessionId !== info.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== info.attachmentId)) return
      if (info.provider !== event.provider || info.model !== event.model || info.reasoningEffort !== event.reasoningEffort) this.infoStamp += 1
      info.provider = event.provider; info.model = event.model
      if (event.reasoningEffort === undefined) delete info.reasoningEffort
      else info.reasoningEffort = event.reasoningEffort
      if (this.dialog instanceof ModelPickerDialog) this.dialog.setCurrentRoute(event.provider, event.model)
      this.render()
      return
    }
    if (event.type === 'presets_changed') {
      if (event.sessionId !== this.info?.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== this.info?.attachmentId)) return
      const state = this.presetPicker
      if (state === undefined || this.dialog !== state.dialog || !this.sameAttachment(state.context)) return
      const request = this.presetCatalogRequest
      if (request?.state === state) request.dirty = true
      else void this.refreshPresetPicker(state)
      return
    }
    if (event.type === 'models_changed') {
      if (event.sessionId !== this.info?.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== this.info?.attachmentId)) return
      const dialog = this.dialog
      if (!(dialog instanceof ModelPickerDialog)) return
      const request = this.modelCatalogRequest
      if (request?.dialog === dialog && this.sameContext(request.context)) request.dirty = true
      else void this.refreshModelPicker(dialog)
      return
    }
    if (event.type === 'commands_changed') {
      if (event.sessionId !== this.info?.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== this.info?.attachmentId)) return
      if (this.editor.isShowingAutocomplete() && this.skillAutocompletePrefix()) this.rememberSkillAutocomplete()
      const request = this.catalogRequest
      if (request?.sessionId === event.sessionId && request.attachmentId === this.info?.attachmentId) request.dirty = true
      else void this.refreshCommands(true)
      return
    }
    if (event.type === 'skills_changed') {
      if (event.sessionId !== this.info?.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== this.info?.attachmentId)) return
      this.invalidateSkills()
      if (this.editor.isShowingAutocomplete() && this.skillAutocompletePrefix()) {
        this.rememberSkillAutocomplete()
        this.editor.ccRefreshAutocomplete()
      }
      void this.refreshSkills()
      return
    }
    // Observe authorized native facts before store callbacks render. A durable
    // turn/end precedes native idle; tentative streams never imply completion.
    if (!('sessionId' in event) || event.sessionId === this.info?.sessionId) this.terminalIntegration.observe(event)
    this.routeChildEvent(event)
    this.store.handle(event)
    if ('sessionId' in event && event.sessionId !== this.info?.sessionId) return
    if (event.type === 'status') {
      const wasBusy = this.isBusy
      this.busy = event.status === 'running'
      if (!wasBusy && this.isBusy) this.startedAt = Date.now()
      if (!this.isBusy) {
        // A settled instruction may have changed git facts; the rate/TTFT
        // chips now come from the native sessionStats fold via `state`.
        this.gitRefresher?.refresh()
      }
      this.refreshQueue()
    } else if (event.type === 'stream_start') {
      this.output.start(event.turn, event.attemptId)
    } else if (event.type === 'stream_chunk') {
      this.output.chunk(event.attemptId, event.chunk)
    } else if (event.type === 'permissions' && this.info) {
      this.info.permissions = event.value
    } else if (event.type === 'todos') {
      // Replace the current native snapshot; no checklist is appended to history.
      this.todos = event.value
      this.todoBoard.todos = event.value
    } else if (event.type === 'plan') {
      this.applyPlanSnapshot(event.value)
    } else if (event.type === 'metrics') {
      // Bridge-pushed native projection frames (one per step / durable event,
      // plus a baseline after attach) keep the footer live through a whole
      // turn; the `state` command stays the baseline/fallback. An absent field
      // means that projection is unavailable, so the current chips stay.
      if (event.usage !== undefined) this.applyUsage(event.usage)
      if (event.stats !== undefined) this.applyStats(event.stats)
    } else if (event.type === 'session_event' && event.event.type === 'user/message') {
      const id = admittedUserMessageId(event.event)
      if (id !== undefined) {
        this.admittedUserMessageIds.add(id)
        if (this.queueRows.some(row => row.messageId === id)) {
          this.queueRows = this.queueRows.filter(row => row.messageId !== id)
          this.queued = this.queueRows.length
          if (this.editingQueueId === id) this.editingQueueId = undefined
          this.render()
        }
      }
    } else if (event.type === 'session_event' && event.event.type === 'turn/start') {
      const data = object(event.event.data)
      this.output.beginTurn(typeof data?.turn === 'number' ? data.turn : undefined, Date.now())
    } else if (event.type === 'session_event' && (event.event.type === 'command/run' || event.event.type === 'command/done')) {
      const wasBusy = this.isBusy
      const data = object(event.event.data)
      if (typeof data?.commandId === 'string') {
        if (event.event.type === 'command/run') this.activeCommands.set(data.commandId, typeof data.name === 'string' ? data.name : 'command')
        else this.activeCommands.delete(data.commandId)
      }
      if (!wasBusy && this.isBusy) this.startedAt = Date.now()
      this.refreshQueue()
    } else if (event.type === 'decision') {
      const attachmentId = this.info?.attachmentId
      if (!this.decisions.some(pending => pending.request.id === event.request.id)) this.decisions.push({ sessionId: event.sessionId, attachmentId, request: event.request })
      this.showNextDecision()
    } else if (event.type === 'decision_closed') this.closeDecision(event.id)
    else if (event.type === 'closed' || (event.type === 'error' && event.fatal)) {
      this.clipboardGeneration += 1; this.clipboardPending = false
      this.closeImageDetails()
      this.closeToolDetails()
      this.closeSubagentSurfaces()
      this.clearSubagentReplyTarget()
      this.connected = false; this.busy = false; this.decisions.length = 0; this.activeCommands.clear(); this.stopSpinner(); this.output.reset()
      this.invalidateSkills(); this.skillsRequest = undefined; this.skillAutocompleteIntent = undefined
      this.editor.ccCancelAutocomplete()
      const oldDialog = this.dialog
      this.hideDialog()
      disposeComponent(oldDialog)
      this.queued = 0; this.queueRequest = undefined
      if (event.type === 'error' || (event.code !== null && event.code !== 0)) this.fatal = true
    }
    this.render()
  }

  /** The status text embedded in the editor's top border. */
  private workingStatus(spinner: string, command: string | undefined, now: number): string {
    const label = this.busy ? 'Working…' : '/' + (command ?? 'command') + '…'
    const details = this.workingDetails(this.busy, now)
    return accent(spinner + ' ' + label) + (details === '' ? '' : dim(' (' + details + ')')) + dim(' · Esc sends queue')
  }

  /**
   * `↓ 186 tokens · 9s` for a model turn. The stream rate is deliberately
   * absent: throughput lives in the footer's native sessionStats chip, so the
   * Working border shows only the token count and elapsed time. Native
   * commands have no output-token stream, so they show only elapsed time after
   * the same 3s threshold Pi uses.
   */
  private workingDetails(modelTurn: boolean, now: number): string {
    const parts: string[] = []
    const tokens = modelTurn ? this.output.total() : 0
    if (tokens > 0) parts.push('↓ ' + formatOutputTokens(tokens) + ' tokens')
    const started = modelTurn && this.output.startTime > 0 ? this.output.startTime : this.startedAt
    const elapsed = Math.max(0, now - started)
    if (elapsed >= 3_000 || tokens > 0) {
      const formatted = formatElapsed(elapsed)
      parts.push(formatted === '' ? '0s' : formatted)
    }
    return parts.join(' · ')
  }

  /**
   * Footer usage facts from the native projections — `metrics` frames during a
   * turn, `state` at baselines: DSH's official context occupancy
   * (`contextPressure`), the whole-log token total and the cache-hit percentage
   * (`tokenUsage` billed-input denominator), all computed bridge-side with the
   * web client's formulas. Missing fields omit their chips.
   */
  private applyUsage(usage: UsageSnapshot | Record<string, unknown> | undefined): void {
    if (usage === undefined) return
    const used = typeof usage.used === 'number' && Number.isFinite(usage.used) ? usage.used : undefined
    const size = typeof usage.size === 'number' && Number.isFinite(usage.size) && usage.size > 0 ? usage.size : undefined
    const cachePct = typeof usage.cachePct === 'number' && Number.isFinite(usage.cachePct) && usage.cachePct > 0
      ? Math.min(100, usage.cachePct) : undefined
    // `tokenUsage` whole-log total (billed input + output), shown as `1.2M tok`.
    const totalTokens = typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
      ? usage.totalTokens : undefined
    const next = used === undefined && size === undefined && cachePct === undefined && totalTokens === undefined ? undefined
      : {
        used: used ?? 0,
        ...(size !== undefined ? { size } : {}),
        ...(cachePct !== undefined ? { cachePct } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
      }
    if (next?.used !== this.usage?.used || next?.size !== this.usage?.size ||
      next?.cachePct !== this.usage?.cachePct || next?.totalTokens !== this.usage?.totalTokens) {
      this.usage = next
      this.render()
    }
  }

  /**
   * Native sessionStats fold: DSH's own turn/step counters, decode throughput
   * and average TTFT. Absent fields (bundle not mounted, no steps yet) omit
   * their chips; the footer never falls back to a local rate estimate. Like
   * `applyUsage` it only touches the footer when a value actually changed and
   * then repaints, so a stats-only projection frame still lands on screen.
   */
  private applyStats(stats: StatsSnapshot | Record<string, unknown> | undefined): void {
    const next = stats === undefined ? undefined : {
      ...(typeof stats.turns === 'number' && Number.isFinite(stats.turns) && stats.turns > 0 ? { turns: stats.turns } : {}),
      ...(typeof stats.steps === 'number' && Number.isFinite(stats.steps) && stats.steps > 0 ? { steps: stats.steps } : {}),
      ...(typeof stats.decodeTokens === 'number' && Number.isFinite(stats.decodeTokens) ? { decodeTokens: stats.decodeTokens } : {}),
      ...(typeof stats.decodeMs === 'number' && Number.isFinite(stats.decodeMs) ? { decodeMs: stats.decodeMs } : {}),
      ...(typeof stats.ttftMs === 'number' && Number.isFinite(stats.ttftMs) ? { ttftMs: stats.ttftMs } : {}),
      ...(typeof stats.ttftSteps === 'number' && Number.isFinite(stats.ttftSteps) ? { ttftSteps: stats.ttftSteps } : {}),
    }
    const meaningful = next !== undefined &&
      (next.turns !== undefined || next.steps !== undefined || next.decodeTokens !== undefined || next.ttftMs !== undefined)
    const value = meaningful ? next : undefined
    if (value?.turns !== this.stats?.turns || value?.steps !== this.stats?.steps ||
      value?.decodeTokens !== this.stats?.decodeTokens || value?.decodeMs !== this.stats?.decodeMs ||
      value?.ttftMs !== this.stats?.ttftMs || value?.ttftSteps !== this.stats?.ttftSteps) {
      this.stats = value
      this.render()
    }
  }

  /** One renderer-owned terminal projection; it never calls into native business services. */
  private syncTerminalPresentation(): void {
    if (this.closing || this.terminalRestored) return
    this.terminalIntegration.update({
      info: this.info,
      busy: this.isBusy,
      activeCommandIds: [...this.activeCommands.keys()],
      connected: this.connected,
      fatal: this.fatal,
      decisions: this.decisions.filter(decision => this.decisionBelongsToCurrentAttachment(decision)).map(decision => decision.request),
      subagents: this.connected ? this.store.subagentEntries : [],
    }, this.settings.get())
  }

  private startSpinner(): void {
    if (this.spinner) return
    this.spinner = setInterval(() => { this.spinnerStep++; this.render() }, 100)
    this.spinner.unref()
  }
  private stopSpinner(): void { if (this.spinner) clearInterval(this.spinner); this.spinner = undefined }

  /** Animation is presentation only: live children never make the root busy. */
  private syncSpinner(): void {
    const childWorking = this.connected && this.store.subagentEntries.some(entry =>
      entry.status === 'running' || entry.status === 'initializing')
    if (!this.settings.get().reducedMotion && (this.isBusy || childWorking)) this.startSpinner()
    else this.stopSpinner()
  }

  /**
   * One adaptive pool for every status dock, not three competing height caps.
   * Keep the usual four transcript rows when possible; a short terminal may
   * borrow down to one so each actually visible dock retains a compact row.
   * The one editor, queue, hints and footer always keep their measured height.
   */
  private statusDockPool(): number {
    const width = Math.max(1, this.tui.terminal.columns)
    const rows = this.tui.terminal.rows
    const chrome = 1 + this.queueList.render(width).length + this.slot.render(width).length +
      this.hint.render(width).length + this.footer.render(width).length
    const preferred = Math.max(0, Math.min(15, Math.floor(rows / 2), rows - chrome - 4))
    const available = Math.max(0, rows - chrome - 1)
    return Math.min(available, Math.max(preferred, this.statusDockMinimumRows()))
  }

  /** Presence comes from the same pure component facts used by the shared stack. */
  private statusDockMinimumRows(): number {
    return this.todoBoard.compactRows + this.goalProgress.compactRows +
      (this.settings.get().showSubagentProgress ? this.subagentProgress.compactRows : 0)
  }

  private render(): void {
    if (this.closing || this.terminalPaused || this.terminalRestored) return
    this.syncToolDetails()
    this.syncImageDetails()
    this.syncSubagentSurfaces()
    this.syncSubagentReplyTarget()
    this.syncSpinner()
    const spinner = WORKING_SPINNER_FRAMES[this.settings.get().reducedMotion ? 0 : this.spinnerStep % WORKING_SPINNER_FRAMES.length]!
    this.todoBoard.todos = this.todos
    this.todoBoard.spinnerFrame = spinner
    const command = this.activeCommands.values().next().value
    this.queueList.rows = this.queueRows
    this.queueList.editingId = this.editingQueueId
    const replyTarget = this.subagentReplyTarget
    this.subagentProgress.entries = this.store.subagentEntries
    this.subagentProgress.truncated = this.store.subagentsTruncated
    this.subagentProgress.replyTargetId = replyTarget?.childId
    this.subagentProgress.spinnerFrame = spinner
    const rootWorking = this.isBusy ? this.workingStatus(spinner, command, Date.now()) : ''
    this.prompt.setWorkingStatus(replyTarget === undefined ? rootWorking
      : accent('Replying to ' + replyTarget.label) + dim(' · Esc to return') +
        (rootWorking === '' ? '' : dim(' · root ') + rootWorking))
    const hint = this.exitArm ? 'Press the same exit key again to exit'
      : this.clipboardPending ? 'Pasting…'
      : this.fileAttachController !== undefined ? 'Attaching local file…'
      : this.chordHint ? this.chordHint.join(' ') + ' …'
      : this.decisionId ? 'Decision · Ctrl+P/N navigate · Enter choose · Esc ' + (this.decisions.find(decision => decision.request.id === this.decisionId)?.request.kind === 'question' ? 'cancel' : 'reject')
      : this.editingQueueId ? 'Editing queued message · Enter saves · Esc leaves the edit'
      : this.dialog ? ''
      : ''
    // An empty Text must stay truly empty: dim('') still emits ANSI escapes,
    // which Text treats as content and renders as a visually blank row.
    this.hint.setText(hint ? dim(hint) : '')
    const model = this.info ? this.info.provider + '/' + this.info.model : 'starting DSH…'
    const status = this.isBusy ? 'working' : this.connected ? 'ready' : 'disconnected'
    // Desktop status-line order (dsh web client): model+effort, status word,
    // preset value (plus the transient queued/next-preset tail), then the
    // native stat chips — context bar, whole-log token total, cache hit,
    // turns/steps, decode rate, TTFT. Sources are the `state` projection's
    // contextPressure / tokenUsage / sessionStats folds; the cwd line carries
    // the git chip and the permission value.
    const effort = this.info?.reasoningEffort
    // Effort is text-only (no circle glyphs) and rides the model as one visual
    // unit: every level except the top one uses the 品牌蓝 (the model's blue),
    // so only `max` needs to stand out. The top level is a CC-style multi-hue
    // marker — one vivid hue per character (pink/orange/cyan) — never a single
    // flat color.
    const effortChip = effort !== undefined && effort !== ''
      ? ' ' + (effort === 'max' ? colorCycled(effort, EFFORT_RAINBOW) : t.accent(effort))
      : ''
    const chips = [t.accent(model) + effortChip, dim(status)]
    if (this.info?.preset !== undefined && this.info.preset !== '') chips.push(dim(this.info.preset))
    const usage = this.usage
    // 1. 上下文 — DSH's official occupancy bar.
    if (usage !== undefined && usage.size !== undefined && usage.size > 0) {
      const pct = Math.min(100, Math.max(0, (usage.used / usage.size) * 100))
      const filled = Math.round((pct / 100) * CONTEXT_BAR_WIDTH)
      const barColor = pct >= 95 ? t.red : pct >= 80 ? t.yellow : t.accent
      chips.push(
        barColor('█'.repeat(filled)) + t.subtle('░'.repeat(CONTEXT_BAR_WIDTH - filled)) +
        t.subtle(` ${Math.floor(pct)}%/${formatOutputTokens(usage.size)}`),
      )
    }
    // 2. 总 tok — the whole-log tokenUsage total (`1.2M tok`).
    if (usage?.totalTokens !== undefined && usage.totalTokens > 0) {
      chips.push(t.subtle(`${formatOutputTokens(usage.totalTokens)} tok`))
    }
    // 3. 缓存 — the tokenUsage billed-input cache share.
    if (usage?.cachePct !== undefined && usage.cachePct > 0) {
      chips.push(t.subtle(`${CACHE_ICON} ${Math.floor(usage.cachePct)}%`))
    }
    // DSH's native sessionStats fold is the only rate/TTFT/turn source (the
    // same numbers the DSH web client shows); no local fallback by design.
    const stats = this.stats
    // 4. 轮/步 — sessionStats turn/step counters (`10 turns 32 steps`).
    if (stats?.turns !== undefined && stats?.steps !== undefined && stats.steps > 0) {
      chips.push(t.subtle(`${stats.turns} turns ${stats.steps} steps`))
    }
    // 5. tok/s — sessionStats decode throughput; TTFT is its own chip now.
    const rate = stats?.decodeTokens !== undefined && stats?.decodeMs !== undefined && stats.decodeMs > 0
      ? (stats.decodeTokens * 1000) / stats.decodeMs : 0
    if (rate > 0) chips.push(t.subtle(formatOutputRate(rate)))
    // 6. ttft — sessionStats mean time to first token (`TTFT: 4.7s`).
    const ttft = stats?.ttftMs !== undefined && stats?.ttftSteps !== undefined && stats.ttftSteps > 0
      ? stats.ttftMs / stats.ttftSteps : 0
    if (ttft > 0) chips.push(t.subtle(`TTFT: ${formatTtft(ttft)}`))
    const staged = this.nextPreset ? ' · next preset: ' + this.nextPreset : ''
    let place = t.accent(this.info?.cwd ?? this.options.cwd)
    // The permission value rides directly behind the path; the git chip
    // follows it (the user's requested order).
    const directory = this.nativeDirectory
    if (directory?.available === true && typeof directory.effectiveCwd === 'string' && directory.effectiveCwd !== (this.info?.cwd ?? this.options.cwd)) {
      place += dim(' · effective: ') + t.accent(oneLine(sanitize(directory.effectiveCwd), 180))
    }
    if (this.info?.permissions?.currentValue !== undefined && this.info.permissions.currentValue !== '') {
      place += dim(' · ') + t.subtle(this.info.permissions.currentValue)
    }
    const git = this.gitStats
    if (git?.branch !== undefined) {
      let gitChip = t.accentBright(`${GIT_ICON} ${git.branch}`)
      if (git.status !== undefined) gitChip += t.subtle(' [') + styledGitStatus(git.status) + t.subtle(']')
      if (git.add > 0 || git.del > 0) {
        gitChip += t.subtle('(') + t.green('+' + git.add) + ' ' + t.red('−' + git.del) + t.subtle(')')
      }
      place += dim(' · ') + gitChip
    }
    this.footer.setText(chips.join(dim(' · ')) + dim(staged) + '\n' + place)
    this.syncTerminalPresentation()
    this.tui.requestRender()
  }

  private showDialog(dialog: Component, decision = false): void {
    if (this.decisionId && !decision) {
      if (this.dialog !== dialog) disposeComponent(dialog)
      this.store.report('Resolve the pending DSH decision before opening another dialog.')
      return
    }
    this.transcript.releaseHover()
    this.closeImageDetails()
    this.closeToolDetails()
    this.closeSubagentSurfaces()
    this.surfaceGeneration += 1
    this.dialogOverlay?.hide(); this.dialogOverlay = undefined
    if (this.dialog && this.dialog !== dialog) disposeComponent(this.dialog)
    if (this.presetPicker?.dialog !== dialog) { this.presetPicker = undefined; this.presetCatalogRequest = undefined }
    this.keymap.cancelChord(); this.chordHint = undefined
    this.dialog = dialog
    // The one composer stays mounted and untouched behind the modal. Only the
    // active overlay owns input; no draft/undo/image state is copied or reset.
    this.slot.clear(); this.slot.addChild(this.prompt)
    const size = (dialog as Component & { modalSize?: ModalSize }).modalSize ?? 'standard'
    this.dialogOverlay = this.tui.showOverlay(dialog, modalOverlayOptions(size))
    this.syncOverlayMouse()
    this.tui.setFocus(dialog); this.render()
  }
  private hideDialog(): void {
    this.surfaceGeneration += 1
    this.keymap.cancelChord(); this.chordHint = undefined
    this.dialogOverlay?.hide(); this.dialogOverlay = undefined
    this.dialog = undefined; this.decisionId = undefined
    this.presetPicker = undefined; this.presetCatalogRequest = undefined
    this.slot.clear(); this.slot.addChild(this.prompt)
    this.syncOverlayMouse()
    this.tui.setFocus(this.prompt)
    this.showNextDecision(); this.render()
  }

  /** Hide the current non-decision surface and release its editor resources. */
  private dismissDialog(): void {
    const dialog = this.dialog
    this.hideDialog()
    disposeComponent(dialog)
  }

  /** Current attachment owns decisions; stale requests from an old attachment stay ignored. */
  private decisionBelongsToCurrentAttachment(decision: PendingDecision): boolean {
    return decision.sessionId === this.info?.sessionId &&
      (decision.attachmentId === undefined || this.info?.attachmentId === undefined || decision.attachmentId === this.info.attachmentId)
  }

  private showNextDecision(): void {
    if (this.closing || this.decisionId || !this.connected) return
    const pending = this.decisions.find(decision => this.decisionBelongsToCurrentAttachment(decision))
    if (!pending) return
    const request = pending.request
    const displayRequest: DecisionRequest = request.origin === undefined ? request : {
      ...request,
      title: `${request.origin.label ?? (request.origin.untracked === true ? 'Child session (untracked)' : request.origin.childSessionId)} › ${request.title}`,
    }
    this.decisionId = request.id
    const extras: DecisionDialogExtras = {
      onInterrupt: () => { void this.interrupt() },
    }
    const options = {
      request: displayRequest,
      onSubmit: (value: unknown) => { void this.answer(request.id, value) },
      // Approval Esc uses DSH's native reject option; question Esc settles that
      // one native request as cancelled. Ctrl+C still goes through the backend
      // cancel path (a whole-turn abort) instead.
      onCancel: () => {
        if (request.kind === 'question') { this.cancelQuestion(request.id); return }
        const rejection = this.rejectionValue(request)
        void this.answer(request.id, rejection.value)
      },
      keymap: this.keymap,
      ...extras,
    } as ConstructorParameters<typeof DecisionDialog>[1] & DecisionDialogExtras
    this.showDialog(new DecisionDialog(this.tui, options), true)
  }

  private rejectionValue(request: DecisionRequest): { value: unknown } {
    const options = request.options ?? []
    const match = options.find(option => {
      if (typeof option.value === 'string' && /^(rejected|reject|deny|denied|decline)$/i.test(option.value)) return true
      const value = object(option.value)
      if (value) {
        if (value.outcome === 'rejected' || value.outcome === 'deny' || value.outcome === 'denied') return true
        if (value.allow === false || value.allowed === false || value.approved === false) return true
      }
      return /^(reject|deny|decline)\b/i.test(option.label.trim())
    })
    return { value: match?.value ?? { cancelled: true } }
  }

  /**
   * Esc on a question cancels exactly that native request (CC/Pi semantics):
   * the surface leaves at once, the request is settled through the existing
   * respond channel with `{cancelled:true}`, and nothing stays pending behind
   * a hidden dialog. The native `decision_closed` that follows is then a no-op.
   */
  private cancelQuestion(id: string): void {
    const index = this.decisions.findIndex(decision => decision.request.id === id)
    if (index < 0 || this.decisionId !== id) return
    const context = this.context()
    this.decisions.splice(index, 1)
    const dialog = this.dialog
    // Dismiss first so the next pending decision (if any) owns the surface
    // while the native settlement is in flight.
    this.hideDialog()
    disposeComponent(dialog)
    void this.options.backend.respond(id, { cancelled: true }).catch(error => {
      if (!this.closing && this.sameContext(context)) this.store.report(errorText(error), 'error')
    })
  }

  private closeDecision(id: string): void {
    const index = this.decisions.findIndex(decision => decision.request.id === id)
    if (index < 0) return
    this.decisions.splice(index, 1)
    if (this.decisionId === id) {
      const dialog = this.dialog
      this.hideDialog()
      disposeComponent(dialog)
    } else this.render()
  }

  private async answer(id: string, value: unknown): Promise<void> {
    const context = this.context()
    const pending = this.decisions.find(decision => decision.request.id === id && this.decisionBelongsToCurrentAttachment(decision))
    if (!pending || !this.sameContext(context)) return
    try {
      await this.options.backend.respond(id, value)
      if (!this.sameContext(context)) return
      this.closeDecision(id)
    } catch (error) { if (!this.closing && this.sameContext(context)) this.store.report(errorText(error), 'error') }
  }

  /** Non-mutating binding lookup: editor remains the sole key/chord dispatcher. */
  private bound(data: string, id: string): boolean {
    return this.keymap.getBindings(id).some(binding => !binding.includes(' ') && matchesKey(data, binding as KeyId))
  }

  private beforeInput(data: string): boolean {
    this.inputGeneration += 1
    if (this.editor.isPasting() || data.startsWith('\x1b[200~') || this.keymap.isPendingChord() || this.editor.capturesViewportInput) return false
    const up = this.bound(data, 'editor.move.line-up') || this.bound(data, 'editor.history.previous')
    const down = this.bound(data, 'editor.move.line-down') || this.bound(data, 'editor.history.next')
    if (this.editingQueueId) return false
    if (up && (this.busy || this.queued > 0 || this.queuedAttachmentRecoveries.has(this.info?.sessionId ?? '')) && !this.editor.getExpandedText() && this.info?.capabilities.includes('dequeue')) {
      if (!this.queueRecallPending) void this.recallQueue(data)
      return true
    }
    if (up && !this.editor.getExpandedText() && this.cleared) {
      const before = this.editor.captureDraft()
      this.updatingDraft = true; this.editor.restoreDraft(this.cleared); this.updatingDraft = false
      this.cleared = undefined
      this.exitArm = undefined
      if (this.exitTimer) clearTimeout(this.exitTimer)
      this.restored = { text: this.editor.getExpandedText(), before }
      return true
    }
    if (down && this.restored && this.editor.getExpandedText() === this.restored.text) {
      const before = this.restored.before; this.restored = undefined; this.editor.restoreDraft(before); return true
    }
    if (!this.bound(data, 'app.interrupt') && !this.bound(data, 'app.exit') && !this.bound(data, 'editor.delete.char-forward')) this.exitArm = undefined
    return false
  }

  private async recallQueue(key: string): Promise<void> {
    this.queueRecallPending = true
    const context = this.context(), editor = context.editor, before = editor.captureDraft()
    const sessionId = context.sessionId, attachmentId = context.attachmentId, history = this.history
    const controller = new AbortController()
    this.queueReadController = controller
    try {
      const recovery = sessionId === undefined ? undefined : this.queuedAttachmentRecoveries.get(sessionId)
      if (recovery === undefined && this.queuedAttachmentRecoveries.size >= 8) {
        throw new Error('Too many retrieved attachment drafts are waiting for editing. Restore one of those sessions first; the native queue was left untouched.')
      }
      const result = recovery ?? await this.options.backend.command('dequeue', { sessionId, attachmentId })
      const messages: QueuedAttachmentRecovery[] = Array.isArray(result) ? result.flatMap(value => {
        if (typeof value === 'string') return [{ text: value, content: [] }]
        const message = object(value)
        if (message === undefined) return []
        const content = displayContentParts(message.content)
        const text = typeof message.text === 'string' ? message.text : content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
        return [{ text, content, ...(typeof message.messageId === 'string' ? { messageId: message.messageId } : {}) }]
      }) : []
      const texts = messages.map(message => message.text)
      const hasAttachments = messages.some(message => message.content.some(part => part.type !== 'text'))
      // A dequeue already transferred these messages. Retain native refs on read
      // failure, cancellation or a competing draft; never fall back to image-less text.
      if (hasAttachments && sessionId !== undefined) this.queuedAttachmentRecoveries.set(sessionId, messages)
      if (!this.sameContext(context)) {
        if (!hasAttachments) for (const text of texts) void history.add(text).catch(() => {})
        return
      }
      const draftChanged = () => editor.getText() !== before.lines.join('\n') || editor.isPasting() || this.keymap.isPendingChord()
      if (draftChanged()) {
        if (!hasAttachments) for (const text of texts) { editor.addToHistory(text); void history.add(text).catch(() => {}) }
        if (messages.length) this.store.report(hasAttachments
          ? 'Retrieved attachment inputs were kept for editing. Stash your new draft, then press Up on the empty prompt to retry.'
          : 'Retrieved queued inputs were kept in recall history; your new draft was not replaced.')
        return
      }
      if (!messages.length) { editor.handleInput(key); return }
      if (!hasAttachments) {
        this.updatingDraft = true
        try { editor.replaceDraftText(texts.join('\n\n')) } finally { this.updatingDraft = false }
      } else {
        const parts: PromptContentPart[] = []
        for (const [index, message] of messages.entries()) {
          if (index > 0) parts.push({ type: 'text', text: '\n\n' })
          for (const part of message.content.length ? message.content : [{ type: 'text' as const, text: message.text }]) {
            if (part.type === 'text') parts.push(part)
            else if (part.type === 'image') {
              const read = this.options.backend.readImage
              if (read === undefined) throw new Error('Image reads are unavailable; the retrieved native references were kept. Press Up to retry after restoring the backend.')
              const value = imageAttachmentValue(await read.call(this.options.backend, part.attachment, controller.signal), part.attachment)
              if (controller.signal.aborted || !this.sameContext(context)) return
              parts.push({ type: 'image', mediaType: value.attachment.mediaType, data: value.data,
                ...(value.attachment.name === undefined ? {} : { name: value.attachment.name }) })
            } else if (part.type === 'file') {
              // Already durable native refs are ready admission parts; no byte re-read.
              parts.push(part)
            }
          }
        }
        if (controller.signal.aborted || !this.sameContext(context) || draftChanged()) {
          if (this.sameContext(context)) this.store.report('Retrieved attachment inputs were kept for editing; your newer draft was not replaced.')
          return
        }
        this.updatingDraft = true
        try {
          editor.replaceDraftText('')
          for (const part of parts) {
            if (part.type === 'image') editor.insertImage(part)
            else if (part.type === 'file') editor.insertFile(part)
            else editor.insertTextAtCursor(part.text)
          }
        } catch (error) {
          editor.restoreDraft(before)
          throw error
        } finally { this.updatingDraft = false }
        if (sessionId !== undefined) this.queuedAttachmentRecoveries.delete(sessionId)
      }
      this.restored = { text: editor.getExpandedText(), before }
    } catch (error) {
      if (this.sameContext(context) && !controller.signal.aborted) this.store.report('Could not retrieve queue: ' + errorText(error), 'error')
    } finally {
      if (this.queueReadController === controller) this.queueReadController = undefined
      this.queueRecallPending = false; this.refreshQueue(); this.render()
    }
  }

  private dispatchAction(event: CcActionEvent): boolean {
    switch (event.id) {
      case 'app.interrupt': {
        const replyTarget = this.subagentReplyTarget
        if (replyTarget !== undefined) {
          const entry = this.store.subagentEntry(replyTarget.childId)
          if (this.canStopSubagent(entry)) void this.interruptSubagent(entry)
          else if (!event.empty) {
            this.cleared = this.editor.captureDraft()
            this.editor.replaceDraftText('')
            this.armExit(event.id)
          } else this.armExit(event.id)
          break
        }
        if (this.queueRecallPending) {
          this.queueReadController?.abort()
          if (!this.isBusy && event.empty) break
        }
        if (this.clipboardPending) {
          this.clipboardGeneration += 1; this.clipboardPending = false
          if (!this.isBusy && event.empty) break
        }
        if (this.isBusy) void this.interrupt()
        else if (!event.empty) {
          // CC: the first idle Ctrl+C clears the draft and arms the next press
          // as exit. Typing or restoring the draft disarms it.
          this.cleared = this.editor.captureDraft()
          this.editor.replaceDraftText('')
          this.armExit(event.id)
        }
        else this.armExit(event.id)
        break
      }
      case 'app.cancel':
        // Esc changes only the Editor destination; it never interrupts the
        // root Agent or the addressed child and never discards the draft.
        if (this.subagentReplyTarget !== undefined) {
          this.clearSubagentReplyTarget()
          break
        }
        if (this.editingQueueId && !this.isBusy) {
          this.editingQueueId = undefined
          this.updatingDraft = true
          try { this.editor.replaceDraftText('') } finally { this.updatingDraft = false }
          break
        }
        if (this.queueRecallPending) { this.queueReadController?.abort(); break }
        if (this.clipboardPending) { this.clipboardGeneration += 1; this.clipboardPending = false; break }
        if (this.isBusy) void this.interrupt({ drain: true })
        else if (this.queueRows.length > 0) {
          // CC: Esc does not send the draft. It releases the queue immediately.
          void this.releaseQueue()
          if (!event.empty) {
            const now = Date.now()
            if (now - this.escapeAt < 400) { this.cleared = this.editor.captureDraft(); this.editor.replaceDraftText(''); this.escapeAt = 0 }
            else this.escapeAt = now
          }
        }
        else {
          const now = Date.now()
          if (!event.empty && now - this.escapeAt < 400) { this.cleared = this.editor.captureDraft(); this.editor.replaceDraftText(''); this.escapeAt = 0 }
          else this.escapeAt = now
        }
        break
      case 'app.exit':
        // Exit is empty-input only even if a user remaps Ctrl+D onto app.exit
        // or disables the editor's forward-delete binding.
        if (!event.empty) break
        this.armExit(event.id)
        break
      case 'app.redraw': this.tui.requestRender(true); break
      case 'app.history.search': this.searchHistory(); break
      case 'app.stash':
        if (!event.empty) { this.stashed = this.editor.captureDraft(); this.editor.replaceDraftText('') }
        else if (this.stashed) { this.editor.restoreDraft(this.stashed); this.stashed = undefined }
        break
      case 'app.tools.expand': this.transcript.toggleToolsExpanded(); break
      case 'app.tools.details': this.openToolDetails(); break
      case 'app.images.details': this.openImageDetails(); break
      case 'app.subagents.details': this.openAgentsOverlay(); break
      case 'app.queue.open': this.openQueue(); break
      case 'app.thinking.toggle': {
        // CC-style cycle: hidden → collapsed summaries → expand/collapse the
        // latest run. The master show/hide switch lives in /settings → Thinking.
        if (!this.viewOptions.showThinking) this.viewOptions.showThinking = true
        else this.transcript.toggleLatestThinking()
        this.transcript.invalidate()
        break
      }
      case 'app.model.select': void this.pick('models'); break
      case 'app.mode.cycle': void this.cyclePermission(); break
      case 'app.editor.external': void this.externalEditor(); break
      case 'app.clipboard.pasteImage': void this.pasteClipboard(); break
      case 'app.message.sendNow':
        if (event.empty) { void this.sendQueued(this.queueRows[0]?.messageId); break }
        if (!this.editor.disableSubmit) { this.nextSendMode = 'send-now'; this.editor.ccSubmit() }
        break
      case 'app.message.steer':
        if (!event.empty && !this.editor.disableSubmit) { this.nextSendMode = 'steer'; this.editor.ccSubmit() }
        break
      case 'app.message.followUp':
        if (!event.empty && !this.editor.disableSubmit) { this.nextSendMode = 'followup'; this.editor.ccSubmit() }
        break
      case 'app.suspend': this.suspend(); break
      case 'app.todo': this.toggleTodos(); break
      case 'app.help': void this.slash('/help'); break
      default: this.store.report('Action is not yet integrated: ' + event.id); break
    }
    this.render()
    return true
  }

  private armExit(id: string): void {
    const now = Date.now()
    if (this.exitArm?.id === id && now - this.exitArm.at < EXIT_ARM_MS) { void this.shutdown(0); return }
    this.exitArm = { id, at: now }
    this.render()
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.exitTimer = setTimeout(() => { this.exitArm = undefined; this.render() }, EXIT_ARM_MS)
    this.exitTimer.unref()
  }

  private searchHistory(): void {
    const original = this.editor.captureDraft()
    this.showDialog(new HistorySearch(this.tui, this.history.entries(), this.keymap, this.screen, (text, execute) => {
      this.dismissDialog()
      this.editor.restoreDraft(original)
      if (text !== undefined) this.editor.replaceDraftText(text)
      if (execute && text?.trim()) { this.editor.replaceDraftText(''); void this.submit(text) }
      this.render()
    }))
  }

  async submit(text: string, mode: 'followup' | 'steer' | 'send-now' = 'followup', payload?: CcSubmitPayload): Promise<void> {
    const hasAttachments = payload?.content.some(part => part.type !== 'text') === true
    if ((!text.trim() && !hasAttachments) || this.closing) return
    const context = this.context(), editor = context.editor, history = this.history
    const draftBeforeSend = editor.getText()
    const restore = () => {
      // A native failure never overwrites a newer draft or a replacement attachment/editor.
      if (!this.sameAttachment(context) || editor.getText() !== draftBeforeSend) return
      if (payload !== undefined) editor.restoreDraft(payload.snapshot)
      else editor.replaceDraftText(text)
    }
    if (this.clipboardPending || this.fileAttachController !== undefined) {
      restore(); this.store.report('Wait for the attachment input to finish; your draft was kept.'); return
    }
    const replyTarget = this.subagentReplyTarget
    if (replyTarget !== undefined) {
      if (mode === 'send-now') {
        restore()
        this.store.report('Send-now is unavailable for a subagent reply. Use ordinary queue delivery or native steer; your draft was kept.', 'error')
        this.render()
        return
      }
      const current = this.store.subagentEntry(replyTarget.childId)
      if (!this.connected || this.info?.sessionId !== replyTarget.rootSessionId ||
        this.info.capabilities.includes('subagent-prompt') !== true ||
        current === undefined || current.parentSessionId !== replyTarget.parentSessionId || !subagentCanReply(current)) {
        restore()
        this.store.report('The addressed native subagent is unavailable. Your draft was kept; press Esc to return to the root session.', 'error')
        this.render()
        return
      }
      const requestId = randomUUID()
      const delivery = mode === 'steer' ? 'steer' : 'queue'
      const content: readonly PromptContentPart[] = hasAttachments
        ? payload!.content
        : [{ type: 'text', text }]
      try {
        const receipt = object(await this.options.backend.command('subagent-prompt', {
          sessionId: replyTarget.childId,
          requestId,
          delivery,
          content,
        }))
        if (typeof receipt?.messageId !== 'string' || receipt.messageId === '') {
          throw new Error('DSH returned an invalid subagent prompt receipt')
        }
      } catch (error) {
        restore()
        if (this.sameContext(context)) this.store.report('Subagent reply not accepted: ' + errorText(error), 'error')
        this.render()
        return
      }
      if (this.sameContext(context)) {
        editor.addToHistory(text)
        this.restored = undefined
        this.store.report('Reply accepted for ' + replyTarget.label + ' (' + delivery + '); DSH owns execution.')
      }
      void history.add(text).catch(error => { if (!this.closing) this.store.report('Reply accepted, but recall history was not saved: ' + errorText(error), 'error') })
      this.render()
      return
    }
    const editingId = this.editingQueueId
    if (editingId !== undefined && mode === 'followup' && !hasAttachments) {
      try {
        await this.options.backend.command('queue-replace', { messageId: editingId, text })
        if (this.sameContext(context)) {
          this.editingQueueId = undefined
          editor.addToHistory(text)
        }
      } catch (error) {
        restore()
        if (this.sameContext(context)) this.store.report('Queued edit was not saved: ' + errorText(error), 'error')
      }
      this.refreshQueue()
      this.render()
      return
    }
    if (text.startsWith('/')) {
      let skillPrompt: boolean | undefined = false
      // Keep UI-owned/non-skill command dispatch synchronous until its own
      // first native await; menu discovery must not delay /model or /settings.
      if (this.skillPromptCandidate(text)) {
        try {
          skillPrompt = await this.isSkillPrompt(text, context, hasAttachments)
        } catch (error) {
          restore()
          if (this.sameAttachment(context)) this.store.report('Input not accepted: ' + errorText(error), 'error')
          this.render()
          return
        }
      }
      if (skillPrompt === undefined || !this.sameAttachment(context)) { restore(); return }
      if (!skillPrompt) {
        if (hasAttachments) {
          const name = /^\/([^\s]+)/.exec(text)?.[1]?.toLowerCase() ?? ''
          if (this.isUiCommand(name)) {
            restore(); this.store.report('This TUI action does not accept prompt attachments; your draft was kept.', 'error'); return
          }
          if (!this.info?.capabilities.includes('execute')) {
            restore(); this.store.report('Native command attachment execution is unavailable; your draft was kept.', 'error'); return
          }
          // Native execute owns descriptor restrictions and image admission (not model vision).
          const attachments = payload!.content.filter(part => part.type !== 'text')
          const result = object(await this.runRemote('execute', { line: text, attachments }))
          if (result?.attachmentOutcome !== 'success') restore()
          this.render(); return
        }
        await this.slash(text); return
      }
      // A native /name gesture is literal user input: reuse normal text/image queue/steer admission.
    }
    if (mode === 'send-now') {
      let accepted = false
      try {
        const args: Record<string, unknown> = hasAttachments ? { content: payload!.content } : { text }
        if (editingId !== undefined) args.messageId = editingId
        await this.options.backend.command('queue-send-now', args)
        accepted = true
        if (this.sameContext(context)) {
          this.editingQueueId = undefined
          editor.addToHistory(text)
          this.restored = undefined
        }
      } catch (error) {
        restore()
        if (this.sameContext(context)) this.store.report('Prompt not accepted: ' + errorText(error), 'error')
      }
      if (accepted && text.trim() !== '') {
        void history.add(text).catch(error => { if (!this.closing) this.store.report('Prompt accepted, but recall history was not saved: ' + errorText(error), 'error') })
      }
      this.refreshQueue()
      this.render()
      return
    }
    if (!this.connected) { restore(); this.store.report('DSH is disconnected. Check the error above, then restart.', 'error'); return }
    try {
      if (hasAttachments) {
        const sendContent = this.options.backend.sendContent
        if (sendContent === undefined) throw new Error('This backend does not support native attachment prompt admission. Your draft was kept.')
        await sendContent.call(this.options.backend, payload!.content, mode)
      } else await this.options.backend.send(text, mode)
    } catch (error) {
      restore()
      if (this.sameContext(context)) this.store.report('Prompt not accepted: ' + errorText(error), 'error')
      this.render(); return
    }
    if (this.sameContext(context)) { editor.addToHistory(text); this.restored = undefined }
    // Recall history is text-only; native file refs and encoded draft images stay in the one editor/DSH stores.
    void history.add(text).catch(error => { if (!this.closing) this.store.report('Prompt accepted, but recall history was not saved: ' + errorText(error), 'error') })
    this.refreshQueue()
    this.render()
  }

  private editQueued(messageId: string): void {
    const row = this.queueRows.find(item => item.messageId === messageId)
    if (row === undefined) return
    if (row.images > 0 || (row.files ?? 0) > 0) {
      this.store.report('Recover attachment references with Up on an empty prompt before editing this native queued message.')
      return
    }
    this.editingQueueId = messageId
    this.updatingDraft = true
    try { this.editor.replaceDraftText(row.text) } finally { this.updatingDraft = false }
    this.tui.setFocus(this.prompt)
    this.render()
  }

  private async sendQueued(messageId: string | undefined, propagateFailure = false): Promise<void> {
    if (messageId === undefined) return
    if (this.editingQueueId === messageId && this.editor.getText().trim() !== '') {
      this.nextSendMode = 'send-now'
      this.editor.ccSubmit()
      return
    }
    const context = this.context()
    try {
      await this.options.backend.command('queue-send-now', { messageId })
    } catch (error) {
      if (this.sameContext(context)) this.store.report('Prompt not accepted: ' + errorText(error), 'error')
      if (propagateFailure) throw error
    }
    this.refreshQueue()
    this.render()
  }

  private async cancelQueued(messageId: string, propagateFailure = false): Promise<void> {
    if (this.queueRemovals.has(messageId)) return
    this.queueRemovals.add(messageId)
    const context = this.context()
    this.queueRows = this.queueRows.filter(row => row.messageId !== messageId)
    if (this.editingQueueId === messageId) {
      this.editingQueueId = undefined
      this.updatingDraft = true
      try { this.editor.replaceDraftText('') } finally { this.updatingDraft = false }
    }
    this.render()
    try {
      await this.options.backend.command('queue-remove', { messageId })
    } catch (error) {
      const text = errorText(error)
      if (this.sameContext(context) && !text.includes('queued message is gone')) {
        this.store.report(text, 'error')
        if (propagateFailure) { void this.refreshQueue(); throw error }
      }
    } finally {
      this.queueRemovals.delete(messageId)
    }
    this.refreshQueue()
    this.render()
  }

  /** Release the first queued row. DSH then claims the rest one turn at a time. */
  private async releaseQueue(): Promise<void> {
    const messageId = this.queueRows[0]?.messageId
    if (messageId === undefined) return
    const context = this.context()
    try {
      await this.options.backend.command('queue-send-now', { messageId })
      if (this.sameContext(context) && this.editingQueueId === messageId) this.editingQueueId = undefined
    } catch (error) {
      if (this.sameContext(context)) this.store.report('Prompt not accepted: ' + errorText(error), 'error')
    }
    this.refreshQueue()
    this.render()
  }

  async interrupt(options?: { drain?: boolean }): Promise<void> {
    this.clipboardGeneration += 1; this.clipboardPending = false
    this.fileAttachController?.abort(); this.fileAttachController = undefined
    this.queueReadController?.abort(); this.queueReadController = undefined
    this.closeImageDetails()
    this.closeToolDetails()
    const context = this.context()
    const before = this.queued
    try {
      await this.options.backend.cancel()
      await this.refreshQueue()
      if (!this.sameContext(context)) return
      if (options?.drain && this.queueRows.length > 0) {
        await this.releaseQueue()
        return
      }
      if (before === 0 && this.queued > 0) {
        this.store.report(this.queued + ' queued message(s) retained by DSH. They stay listed above the prompt. Up on an empty prompt edits them together. Ctrl+C does not send them.')
      }
    }
    catch (error) { this.store.report(errorText(error), 'error') }
  }

  private async slash(text: string): Promise<void> {
    // Only UI-owned commands are parsed here. Native input is forwarded without
    // changing whitespace, multiline arguments, audit text or validation rules.
    const matched = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text)
    const name = matched?.[1]?.toLowerCase() ?? ''
    const argument = matched?.[2]?.trim() ?? ''
    if (name === 'exit' || name === 'quit') { await this.shutdown(0); return }
    if (name === 'help') { await this.openHelp(); return }
    if (name === 'reload') { await this.reloadRuntime(); return }
    if (name === 'settings' || name === 'config') { this.openSettings(); return }
    if (name === 'agent') { this.openAgentsOverlay(); return }
    if (this.optionalUiCommands().some(command => command.name === name)) {
      if (name === 'jobs') { this.nativeUi.openJobs(); return }
      if (name === 'inspect') { this.nativeUi.openInventory(); return }
      if (name === 'questions') { this.nativeUi.openQuestions(); return }
      if (name === 'rename') { if (argument) this.nativeUi.renameTo(argument); else this.nativeUi.openRename(); return }
      if (name === 'fork') { if (argument) this.store.report('Use /fork without arguments to confirm the current native durable boundary.', 'error'); else this.nativeUi.openFork(); return }
      if (name === 'attach') { await this.attachLocalFile(argument); return }
    }
    if (name === 'model') { if (argument) await this.runRemote('model', { id: argument }); else await this.pick('models'); return }
    if (name === 'effort') { await this.effortCommand(argument); return }
    if (name === 'preset') { await this.presetCommand(argument); return }
    if (name === 'resume') { if (argument) await this.runRemote('resume', { sessionId: argument }); else await this.pick('sessions'); return }
    if (name === 'new' || name === 'clear') {
      await this.runRemote('new', this.nextPreset === undefined ? undefined : { preset: this.nextPreset }); return
    }
    if (!this.connected) { this.store.report('DSH is disconnected.', 'error'); return }
    if (!this.info?.capabilities.includes('execute')) { this.store.report('Native DSH command execution is unavailable in this runtime.', 'error'); return }
    await this.runRemote('execute', { line: text }, name === 'permission' ? 'status-only' : 'normal')
  }

  private async cyclePermission(): Promise<void> {
    const context = this.context()
    try {
      if (!this.info?.capabilities.includes('permissions') || !this.info.capabilities.includes('execute')) {
        throw new Error('This backend does not expose native permission switching')
      }
      const current = object(await this.options.backend.command('permissions'))
      if (!this.sameContext(context)) return
      const options = Array.isArray(current?.options) ? current.options.map(object).filter(item => typeof item?.value === 'string') : []
      if (!options.length) throw new Error('This backend has no selectable permission presets')
      const index = options.findIndex(item => item?.value === current?.currentValue)
      const next = options[(index + 1) % options.length]
      await this.runRemote('execute', { line: '/permission ' + next?.value }, 'status-only')
    } catch (error) { this.store.report(errorText(error), 'error') }
  }

  private async runRemote(name: string, args?: Record<string, unknown>, feedback: 'normal' | 'status-only' = 'normal'): Promise<unknown> {
    const context = this.context()
    const stamp = this.infoStamp
    try {
      const result = await this.options.backend.command(name, args)
      const routeChanging = ['new', 'resume', 'model', 'effort', 'preset', 'session-fork'].includes(name)
      if (!(routeChanging ? this.sameAttachment(context) : this.sameContext(context))) return result
      if (this.closing) return result
      // A `ready` event that landed while this request was in flight is DSH's
      // later native truth. Never overwrite it with the older command response.
      // Legitimate own results still apply when no event was observed.
      const eventApplied = this.infoStamp !== stamp
      const info = object(result)
      if (info && typeof info.sessionId === 'string' && typeof info.cwd === 'string' && typeof info.provider === 'string' && typeof info.model === 'string' && Array.isArray(info.capabilities)) {
        if (!eventApplied) this.applyInfo(result as SessionInfo)
      } else if ((name === 'model' || name === 'effort') && this.info && info) {
        if (!eventApplied) {
          if (typeof info.provider === 'string') this.info.provider = info.provider
          if (typeof info.model === 'string') this.info.model = info.model
          if (typeof info.reasoningEffort === 'string') this.info.reasoningEffort = info.reasoningEffort
          else delete this.info.reasoningEffort
        }
        if (!eventApplied) this.infoStamp += 1
      } else if (name === 'execute') {
        const outcome = object(info?.result)
        if (outcome) {
          // Setting changes are already projected into the footer. Keep native
          // execution/audit intact, and suppress only their successful echo.
          if (!(feedback === 'status-only' && outcome.kind === 'success') && typeof outcome.text === 'string' && outcome.text) {
            this.store.report(outcome.text, outcome.kind === 'error' ? 'error' : 'info')
          }
        } else if (result !== undefined) this.store.report('Invalid native command outcome.', 'error')
      } else if (result !== undefined && !['state', 'models', 'sessions', 'titles', 'commands', 'presets', 'efforts', 'auto-title'].includes(name)) this.store.report(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      if ((name === 'model' || name === 'effort') && (!eventApplied ||
          (info?.provider === this.info?.provider && info?.model === this.info?.model))) {
        // Confirmed native setter acknowledgements are status metadata, not
        // transcript output. Disk-flush uncertainty remains in the response;
        // failed/unavailable/unclassified warnings and other notes stay visible.
        const routineNativeSave = info?.defaultPersistence === 'native' &&
          typeof info.defaultWarning === 'string' &&
          info.defaultWarning.startsWith("Saved through DSH's native default-selection service.")
        const persistence = typeof info?.defaultWarning === 'string' && info.defaultPersistence !== 'runtime' && !routineNativeSave
          ? info.defaultWarning : typeof info?.note === 'string' ? info.note : undefined
        if (persistence !== undefined && persistence !== '') this.store.report(persistence)
      }
      this.render()
      return result
    } catch (error) {
      if (['new', 'resume'].includes(name) || this.sameContext(context)) this.store.report(errorText(error), 'error')
      if (this.settingsReturnState !== undefined && this.sameAttachment(context)) this.settingsFeedback = { message: errorText(error), error: true, context }
      return undefined
    }
  }

  private async pick(kind: 'models' | 'sessions' | 'presets' | 'efforts'): Promise<void> {
    if (kind === 'presets') { await this.pickPreset(); return }
    if (kind === 'efforts') { await this.pickEffort(); return }
    if (kind === 'models') { await this.pickModel(); return }
    await this.pickSessions()
  }

  /**
   * `--resume` without an id: the picker opens before the backend connects so
   * the DSH runtime boots behind a visible loading overlay. A selection
   * resumes that session; Esc keeps the new one, and a positional prompt is
   * submitted once either path settles.
   */
  private openStartupSessionPicker(): void {
    let initialSettled = false
    const submitInitial = () => {
      const prompt = this.options.initialPrompt
      if (initialSettled || this.closing || this.fatal || prompt === undefined) return
      initialSettled = true
      void (async () => {
        try {
          // Esc is valid while the native runtime is still starting. Keep the
          // one-shot positional prompt pending instead of dropping it merely
          // because applyInfo() has not marked the backend connected yet.
          if (!this.connected && this.connecting !== undefined) await this.connecting
          if (this.closing || this.fatal || !this.connected) return
          await this.submit(prompt)
        } catch {
          // start() owns native-connect diagnostics; submit() owns send errors.
        }
      })()
    }
    this.pickSessions({
      onSelect: id => {
        void (async () => {
          await this.runRemote('resume', { sessionId: id })
          submitInitial()
        })()
      },
      onCancel: submitInitial,
    })
  }

  /**
   * CC/Pi-style resume picker over DSH's native `sessions` listing. The dialog
   * opens immediately (loading state), the headers-only listing arrives when
   * the backend is ready, and titles stream in only for the visible rows. The
   * dialog owns scope/search/ordering/age; the app projects native DTOs and
   * executes the resume.
   */
  private pickSessions(hooks?: { onSelect?: (id: string) => void; onCancel?: () => void }): void {
    const dialog = new SessionPickerDialog(this.tui, {
      directory: this.options.cwd, keymap: this.keymap, loading: true,
      onSelect: value => {
        if (this.dialog !== dialog) return
        this.dismissDialog()
        if (hooks?.onSelect !== undefined) hooks.onSelect(value)
        else void this.runRemote('resume', { sessionId: value })
      },
      onCancel: () => {
        if (this.dialog !== dialog) return
        this.dismissDialog()
        hooks?.onCancel?.()
      },
      onInterrupt: () => { void this.interrupt() },
      onVisibleIds: ids => { this.fetchSessionTitles(dialog, ids) },
    })
    this.showDialog(dialog)
    void this.loadSessionListing(dialog)
  }

  /** Phase 1: the headers-only listing (no per-session title decompression). */
  private async loadSessionListing(dialog: SessionPickerDialog): Promise<void> {
    try {
      if (this.connecting !== undefined) await this.connecting
      if (this.closing || this.dialog !== dialog) return
      const result = await this.runRemote('sessions', { limit: 200, titles: false })
      if (this.closing || this.dialog !== dialog || !Array.isArray(result)) {
        dialog.setLoading(false)
        this.render()
        return
      }
      dialog.setSessions(result.flatMap(value => {
        const item = object(value)
        const id = item?.id ?? item?.sessionId
        if (!item || typeof id !== 'string' || id === '') return []
        const created = typeof item.createdAt === 'number' ? item.createdAt : undefined
        return [{
          id,
          ...(typeof item.title === 'string' || item.title === null ? { title: item.title } : {}),
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          // Native header creation time is display-only. The backend preserves
          // sessionQuery's order; neither layer stats artifacts or re-sorts.
          ...(created !== undefined && Number.isFinite(created) ? { createdAt: created } : {}),
          ...(item.live === true ? { live: true } : {}),
        }]
      }))
      this.render()
    } catch {
      // Connect or listing failure: the transcript notice carries the detail;
      // drop the overlay so the error is not hidden behind a stuck dialog.
      if (this.dialog === dialog) this.dismissDialog()
      this.render()
    }
  }

  /**
   * Phase 2: titles for the visible rows only. Coalesced and deduplicated;
   * enrichment failures leave `(title unknown)` rows usable and never surface as
   * conversation errors.
   */
  private fetchSessionTitles(dialog: SessionPickerDialog, ids: string[]): void {
    if (this.closing || this.dialog !== dialog) return
    if (!this.info?.capabilities.includes('titles')) return
    const cached = new Map<string, string | null>()
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') continue
      const known = this.sessionTitles.get(id)
      if (known !== undefined) cached.set(id, known)
      else if (!this.sessionTitleIds.has(id)) this.sessionTitleIds.add(id)
    }
    if (cached.size > 0) {
      // Deferred past the component's synchronous refresh so a reopened
      // picker immediately shows its already-known titles.
      void Promise.resolve().then(() => {
        if (this.closing || this.dialog !== dialog) return
        dialog.setTitles(cached)
        this.render()
      })
    }
    if (this.sessionTitleIds.size === 0 || this.titleTimer !== undefined) return
    this.titleTimer = setTimeout(() => {
      this.titleTimer = undefined
      void this.dispatchSessionTitles(dialog)
    }, 25)
    this.titleTimer.unref()
  }

  private async dispatchSessionTitles(dialog: SessionPickerDialog): Promise<void> {
    const ids = [...this.sessionTitleIds].slice(0, 100)
    for (const id of ids) this.sessionTitleIds.delete(id)
    if (ids.length === 0 || this.closing || this.dialog !== dialog) return
    try {
      const result = await this.runRemote('titles', { ids })
      if (this.closing || this.dialog !== dialog || !Array.isArray(result)) return
      const update = new Map<string, string | null>()
      for (const value of result) {
        const item = object(value)
        if (item === undefined || typeof item.sessionId !== 'string' || !ids.includes(item.sessionId)) continue
        // Unknown/unavailable enrichment must not become a cached no-title fact.
        if (typeof item.title !== 'string' && item.title !== null) continue
        const title = item.title
        this.sessionTitles.set(item.sessionId, title)
        update.set(item.sessionId, title)
      }
      if (update.size > 0) { dialog.setTitles(update); this.render() }
    } catch {
      // Titles are optional enrichment; a failed batch stays invisible.
    }
  }

  /** Provider grouping/search are UI projections of DSH's native model DTOs. */
  private async pickModel(): Promise<void> {
    const context = this.context()
    const dialog = new ModelPickerDialog(this.tui, {
      models: [], loading: true, currentProvider: this.info?.provider, currentModel: this.info?.model, keymap: this.keymap,
      onSelect: id => {
        if (this.dialog !== dialog || !this.sameAttachment(context)) return
        this.dismissDialog()
        void this.runRemote('model', { id }).finally(() => this.returnToSettings())
      },
      onCancel: () => { if (this.dialog !== dialog) return; this.dismissDialog(); this.returnToSettings() },
      onInterrupt: () => { if (this.isBusy) void this.interrupt(); else { this.dismissDialog(); this.returnToSettings() } },
    })
    this.showDialog(dialog)
    await this.refreshModelPicker(dialog)
  }

  /** Native metadata invalidation refreshes only the current model surface, never opens one. */
  private refreshModelPicker(dialog: ModelPickerDialog): Promise<void> {
    if (this.closing || this.dialog !== dialog) return Promise.resolve()
    const context = this.context()
    const surface = this.surfaceGeneration
    const existing = this.modelCatalogRequest
    if (existing?.dialog === dialog && existing.surface === surface && this.sameContext(existing.context)) return existing.promise
    const request = { context, dialog, surface, dirty: false, promise: Promise.resolve() }
    this.modelCatalogRequest = request
    request.promise = (async () => {
      try {
        const result = await this.runRemote('models')
        if (this.modelCatalogRequest !== request || this.dialog !== dialog || surface !== this.surfaceGeneration) return
        if (!this.sameContext(context)) { this.dismissDialog(); this.returnToSettings(); return }
        if (request.dirty) return
        if (!Array.isArray(result)) {
          dialog.setError('Could not load native models. Close and reopen to try again.')
          dialog.setLoading(false)
          this.render()
          return
        }
        const models: ModelPickerItem[] = result.flatMap(value => {
          const item = object(value)
          if (!item || typeof item.id !== 'string' || !item.id || typeof item.provider !== 'string' || !item.provider || typeof item.model !== 'string' || !item.model) return []
          return [{
            id: item.id, provider: item.provider, model: item.model,
            label: typeof item.label === 'string' && item.label ? item.label : item.model,
            ...(typeof item.description === 'string' ? { description: item.description } : {}),
            ...(typeof item.isDefault === 'boolean' ? { isDefault: item.isDefault } : {}),
          }]
        })
        dialog.setError(undefined)
        dialog.setModels(models)
        dialog.setLoading(false)
        this.render()
      } finally {
        if (this.modelCatalogRequest === request) {
          this.modelCatalogRequest = undefined
          if (request.dirty && this.dialog === dialog && surface === this.surfaceGeneration && this.sameContext(context)) {
            await this.refreshModelPicker(dialog)
          }
        }
      }
    })()
    return request.promise
  }

  /** Read the native preset roster without using generic command-result rendering. */
  private async presetCatalog(): Promise<Record<string, unknown> | undefined> {
    try {
      return object(await this.options.backend.command('presets'))
    } catch (error) {
      this.store.report(errorText(error), 'error')
      return undefined
    }
  }

  private async presetCommand(argument: string): Promise<void> {
    const context = this.context()
    const surface = this.surfaceGeneration
    const catalog = await this.presetCatalog()
    if (!catalog || !this.sameContext(context) || surface !== this.surfaceGeneration) return
    if (argument === 'status') return
    const entries = Array.isArray(catalog.presets) ? catalog.presets.map(object).filter(item => typeof item?.id === 'string') : []
    if (!argument) { await this.pickPreset(catalog); return }
    const entry = entries.find(item => item?.id === argument)
    if (!entry) {
      this.store.report('Unknown agent preset: ' + argument + '. Available: ' + (entries.map(item => String(item!.id)).join(', ') || 'none'), 'error')
      return
    }
    if (typeof entry.broken === 'string') { this.store.report('Agent preset ' + argument + ' is unavailable: ' + entry.broken, 'error'); return }
    // Unknown read state is not a native lock. Let the supplied selector
    // decide; only a confirmed non-blank session is staged locally.
    if (catalog.blank === false) { this.stagePreset(argument); return }
    await this.applyPreset(argument)
  }

  private stagePreset(id: string): void {
    this.nextPreset = id
    this.render()
  }

  private async applyPreset(id: string): Promise<void> {
    const context = this.context()
    const stamp = this.infoStamp
    try {
      const result = object(await this.options.backend.command('preset', { id }))
      if (!this.sameAttachment(context)) return
      if (result?.locked === true) { this.stagePreset(id); return }
      const applied = this.infoStamp !== stamp
      if (result && typeof result.sessionId === 'string' && typeof result.cwd === 'string' && typeof result.provider === 'string' && typeof result.model === 'string' && Array.isArray(result.capabilities)) {
        if (!applied) this.applyInfo(result as unknown as SessionInfo)
        this.catalogRequest = undefined
        await this.refreshCommands()
      }
      this.render()
    } catch (error) { this.store.report(errorText(error), 'error') }
  }

  private async pickPreset(existing?: Record<string, unknown>): Promise<void> {
    const context = this.context()
    let state: PresetPickerState | undefined
    const dialog = new SelectDialog(this.tui, {
      title: 'Choose agent preset', items: [], loading: true, keymap: this.keymap,
      onSelect: value => {
        if (state === undefined || this.presetPicker !== state || this.dialog !== dialog ||
            !this.sameAttachment(context) || typeof value !== 'string' || state.catalog === undefined) return
        const catalog = state.catalog
        this.dismissDialog()
        if (catalog.blank === false) { this.stagePreset(value); this.returnToSettings(); return }
        void this.applyPreset(value).finally(() => this.returnToSettings())
      },
      onCancel: () => { if (this.dialog !== dialog) return; this.dismissDialog(); this.returnToSettings() },
      onInterrupt: () => { void this.interrupt() },
    })
    this.showDialog(dialog)
    if (this.dialog !== dialog) return
    state = { dialog, context, surface: this.surfaceGeneration }
    this.presetPicker = state
    await this.refreshPresetPicker(state, existing)
  }

  /** Native roster/default invalidation changes only the existing preset surface. */
  private refreshPresetPicker(state: PresetPickerState, initial?: Record<string, unknown>): Promise<void> {
    if (this.closing || this.presetPicker !== state || this.dialog !== state.dialog) return Promise.resolve()
    const existing = this.presetCatalogRequest
    if (existing?.state === state) return existing.promise
    const request = { state, dirty: false, promise: Promise.resolve() }
    this.presetCatalogRequest = request
    request.promise = (async () => {
      try {
        const catalog = initial ?? await this.presetCatalog()
        if (this.presetCatalogRequest !== request || this.presetPicker !== state ||
            this.dialog !== state.dialog || state.surface !== this.surfaceGeneration || request.dirty) return
        if (!this.sameAttachment(state.context)) { this.dismissDialog(); this.returnToSettings(); return }
        const dialog = state.dialog
        if (catalog === undefined) {
          dialog.setLoading(false)
          dialog.setError('Could not load native presets. Close and reopen to try again.')
          this.render()
          return
        }
        state.catalog = catalog
        const current = typeof catalog.current === 'string' ? catalog.current : undefined
        const entries = Array.isArray(catalog.presets) ? catalog.presets.map(object).filter(item => typeof item?.id === 'string') : []
        const items: DecisionOption[] = entries.filter(item => typeof item?.broken !== 'string').map(item => {
          const id = String(item!.id)
          const label = typeof item!.name === 'string' && item!.name.length > 0 ? item!.name : id
          const marks = [id === current ? 'current' : '', item!.isDefault === true ? 'default' : '', id === this.nextPreset ? 'next' : ''].filter(Boolean)
          const detail = typeof item!.description === 'string' && item!.description.length > 0 ? item!.description : id
          return { label: label + (marks.length ? ' · ' + marks.join(' · ') : ''), description: detail, value: id }
        })
        dialog.setError(items.length ? undefined : 'No usable native agent presets are available.')
        dialog.setItems(items, { preserveValue: true })
        dialog.setLoading(false)
        this.render()
      } finally {
        if (this.presetCatalogRequest === request) {
          this.presetCatalogRequest = undefined
          if (request.dirty && this.presetPicker === state && this.dialog === state.dialog &&
              state.surface === this.surfaceGeneration && this.sameAttachment(state.context)) {
            await this.refreshPresetPicker(state)
          }
        }
      }
    })()
    return request.promise
  }

  private async pickPermission(): Promise<void> {
    const context = this.context()
    const dialog = new SelectDialog(this.tui, {
      title: 'Native permission preset', items: [], loading: true, keymap: this.keymap,
      onSelect: value => {
        if (this.dialog !== dialog || !this.sameAttachment(context) || typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(value)) return
        this.confirmPermissionSelection(value, context)
      },
      onCancel: () => { if (this.dialog !== dialog) return; this.dismissDialog(); this.returnToSettings() },
      onInterrupt: () => { void this.interrupt() },
    })
    this.showDialog(dialog)
    const surface = this.surfaceGeneration
    const result = object(await this.runRemote('permissions'))
    if (this.dialog !== dialog || !this.sameAttachment(context) || surface !== this.surfaceGeneration) return
    const items: DecisionOption[] = Array.isArray(result?.options) ? result.options.flatMap(value => {
      const item = object(value)
      if (typeof item?.value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(item.value)) return []
      return [{ value: item.value, label: (typeof item.name === 'string' && item.name.length > 0 ? item.name : item.value) + (item.value === result.currentValue ? ' · current' : ''),
        ...(typeof item.description === 'string' ? { description: item.description } : {}) }]
    }) : []
    dialog.setItems(items); dialog.setLoading(false)
    if (result === undefined || !items.length) dialog.setError('Native permission choices are unavailable in this composition.')
    this.render()
  }

  private confirmPermissionSelection(value: string, context: UiContext): void {
    const dialog = new SelectDialog(this.tui, {
      title: 'Confirm native permission change',
      items: [
        { label: 'Keep current permissions', value: false },
        { label: 'Apply ' + value, description: 'This changes the current native permission preset. Tool safety semantics are owned by DSH; plan guidance is unchanged.', value: true },
      ], keymap: this.keymap,
      onSelect: accepted => {
        if (this.dialog !== dialog || !this.sameAttachment(context)) return
        this.dismissDialog()
        if (accepted === true) void this.runRemote('execute', { line: '/permission ' + value }, 'status-only').finally(() => this.returnToSettings())
        else this.returnToSettings()
      },
      onCancel: () => { if (this.dialog !== dialog) return; this.dismissDialog(); this.returnToSettings() },
      onInterrupt: () => { void this.interrupt() },
    })
    this.showDialog(dialog)
  }

  private async pickEffort(): Promise<void> {
    const context = this.context()
    const dialog = new SelectDialog(this.tui, {
      title: 'Choose reasoning effort', items: [], loading: true, keymap: this.keymap,
      onSelect: value => {
        if (this.dialog !== dialog || !this.sameAttachment(context) || typeof value !== 'string') return
        this.dismissDialog()
        void this.runRemote('effort', { id: value === '' ? null : value }).finally(() => this.returnToSettings())
      },
      onCancel: () => { if (this.dialog !== dialog) return; this.dismissDialog(); this.returnToSettings() },
      onInterrupt: () => { void this.interrupt() },
    })
    this.showDialog(dialog)
    const surface = this.surfaceGeneration
    const data = object(await this.runRemote('efforts'))
    if (this.dialog !== dialog || surface !== this.surfaceGeneration) return
    if (!this.sameContext(context)) { this.dismissDialog(); this.returnToSettings(); return }
    const levels = Array.isArray(data?.efforts) ? data.efforts.map(object).filter(item => typeof item?.id === 'string') : []
    if (data?.available !== true || levels.length === 0) { dialog.setError('This native model exposes no reasoning levels.'); return }
    const selected = typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined
    const effective = typeof data.effectiveEffort === 'string' ? data.effectiveEffort : undefined
    const items: DecisionOption[] = [
      { label: 'Default' + (selected === undefined ? ' · current' : ''), description: typeof data.defaultEffort === 'string' ? 'Model default (' + data.defaultEffort + ')' : 'Provider default', value: '' },
      ...levels.map(item => {
        const id = String(item!.id)
        const label = typeof item!.name === 'string' && item!.name.length > 0 ? item!.name : id
        return { label: label + (id === selected ? ' · current' : id === effective ? ' · effective' : ''), description: typeof item!.description === 'string' ? item!.description : id, value: id }
      }),
    ]
    dialog.setItems(items); dialog.setLoading(false); this.render()
  }

  private async effortCommand(argument: string): Promise<void> {
    if (!argument) { await this.pickEffort(); return }
    if (argument === 'status') { await this.runRemote('efforts'); return }
    await this.runRemote('effort', { id: argument === 'default' ? null : argument })
  }

  /** Read the native auto-title state without blocking startup or reload. */
  private async queryAutoTitle(): Promise<void> {
    const context = this.context()
    try {
      const result = object(await this.options.backend.command('auto-title'))
      if (!this.sameContext(context) || !result) return
      const detail = [result.limitation, result.reason, result.note, result.warning]
        .find((value): value is string => typeof value === 'string' && value.length > 0)
      this.nativeAutoTitle = {
        available: result.available !== false,
        ...(typeof result.enabled === 'boolean' ? { enabled: result.enabled } : {}),
        ...(detail === undefined ? {} : { detail }),
      }
      this.render()
    } catch {
      if (!this.sameContext(context)) return
      this.nativeAutoTitle = { available: false, detail: 'Native state is unreadable; the DSH profile composition remains authoritative.' }
      this.render()
    }
  }

  private applyDisplayPreferences(settings: Settings): void {
    if (this.viewOptions.expandTools !== settings.expandTools) clearToolExpansion()
    Object.assign(this.viewOptions, toolPreferences(settings))
    this.viewOptions.groupSubagentMessages = settings.groupSubagentMessages
    this.viewOptions.showThinking = settings.showThinking
    this.viewOptions.thinkingPreviewLines = settings.thinkingPreviewLines
    this.viewOptions.thinkingLiveTimerMs = settings.thinkingLiveTimerMs
    if (this.tui instanceof TuiAltScreen) this.tui.setCopyOnSelect(settings.copyOnSelect)
    if (this.appliedQueueCollapsed !== settings.queueCollapsed) {
      this.appliedQueueCollapsed = settings.queueCollapsed
      this.queueList.setDefaultCollapsed(settings.queueCollapsed)
    }
    this.imageDetailsOverlay?.dialog.setPreview(settings.imagePreview)
    this.transcript.invalidate()
    this.render()
  }

  private settingsNativeEntries(): NativeSettingsEntry[] {
    const capabilities = this.info?.capabilities ?? []
    const navigate = (operation: () => void): (() => void) => () => {
      if (!(this.dialog instanceof SettingsDialog)) return
      this.settingsReturnState = { view: this.dialog.captureView(), context: this.context() }
      this.settingsFeedback = undefined
      operation()
    }
    const skills = this.skillCatalog
    const autoTitle = this.nativeAutoTitle
    const defaults = this.nativeUi.defaults
    const presetDefault = defaults?.targets.find(target => target.target === 'agent-preset-default')
    const permissionDefault = defaults?.targets.find(target => target.target === 'permission-default-preset')
    return [
      { id: 'native.model', label: 'Current model', value: this.info === undefined ? 'Starting DSH…' : this.info.provider + '/' + this.info.model,
        description: 'DSH owns the catalog. Selection also submits the native default; profile persistence remains host-owned.', available: capabilities.includes('models'),
        onActivate: navigate(() => { void this.pickModel() }) },
      { id: 'native.effort', label: 'Reasoning effort', value: this.info?.reasoningEffort ?? 'Model default',
        description: 'Available levels come from the selected native model.', available: capabilities.includes('efforts'),
        onActivate: navigate(() => { void this.pickEffort() }) },
      { id: 'native.preset', label: 'Agent preset', value: this.nextPreset === undefined ? this.info?.preset ?? 'Native default' : this.nextPreset + ' · staged',
        description: 'Native composition; the current preset is locked once its conversation starts.', available: capabilities.includes('presets'),
        onActivate: navigate(() => { void this.pickPreset() }) },
      { id: 'native.permission', label: 'Current permission', value: this.info?.permissions?.currentValue ?? 'Native default',
        description: 'Select a mounted native permission preset. Plan remains an independent command.', available: capabilities.includes('permissions') && capabilities.includes('execute'),
        onActivate: navigate(() => { void this.pickPermission() }) },
      { id: 'native.skills', label: 'Skills directory', value: skills?.available ? `${skills.entries.length} user-invocable${skills.complete ? '' : ' · incomplete'}` : 'Unavailable',
        description: 'Read-only native metadata in Help; no instruction-body or directory/path subsystem.', available: capabilities.includes('skills'),
        onActivate: navigate(() => { void this.openHelp() }) },
      { id: 'native.plan', label: 'Plan guidance', value: this.planActive === undefined ? 'Native command' : this.planActive ? 'Active' : 'Off',
        description: 'Independent native /plan; it never changes permission. Use the mounted command explicitly.' },
      { id: 'native.autoTitle', label: 'Auto title',
        value: autoTitle === undefined ? 'Reading native state…' : typeof autoTitle.enabled === 'boolean'
          ? (autoTitle.enabled ? 'On' : 'Off') + ' · read-only' : autoTitle.available ? 'Read-only' : 'Unavailable',
        description: autoTitle?.detail ?? 'Read-only; the DSH profile composition owns enablement. When enabled, native titles may use the model.',
        available: autoTitle?.available !== false },
      { id: 'native.defaultPreset', label: 'Default agent preset', value: presetDefault?.effectiveValue ?? presetDefault?.value ?? (defaults === undefined ? 'Reading native state…' : 'Unavailable'),
        description: presetDefault?.limitation ?? 'Changes only the native default via revision-guarded Settings. The current session preset is not selected.',
        available: capabilities.includes('native-defaults') && presetDefault?.writable !== false,
        onActivate: navigate(() => this.nativeUi.openDefaults('agent-preset-default')) },
      { id: 'native.defaultPermission', label: 'Default permission preset', value: permissionDefault?.effectiveValue ?? permissionDefault?.value ?? (defaults === undefined ? 'Reading native state…' : 'Unavailable'),
        description: permissionDefault?.limitation ?? 'Explicitly confirmed native default edit; current permission and Plan remain independent.',
        available: capabilities.includes('native-defaults') && permissionDefault?.writable !== false,
        onActivate: navigate(() => this.nativeUi.openDefaults('permission-default-preset')) },
      { id: 'native.jobs', label: 'Jobs', value: 'Open read-only list', available: capabilities.includes('native-jobs'),
        description: 'Current native owner and unowned jobs, retained output and terminal status; no TUI job supervisor.', onActivate: navigate(() => this.nativeUi.openJobs()) },
      { id: 'native.goal', label: 'Goal status', value: this.goalProgress.goal?.phase ?? (this.goalProgress.state === 'none' ? 'No current goal' : 'Unavailable'),
        description: 'Read-only native goal dock. Create/edit/resume via the mounted /goal command.', available: capabilities.includes('native-goal') },
      { id: 'native.questions', label: 'Continued questions', value: 'Open native pending view', available: capabilities.includes('continued-questions'),
        description: 'Native timed questions only; late replies use the native inbox. No local timeout or cancellation.', onActivate: navigate(() => this.nativeUi.openQuestions()) },
      { id: 'native.inventory', label: 'Mounted capabilities', value: 'Read-only summary',
        available: capabilities.includes('native-inventory') || capabilities.includes('native-tools'),
        description: 'Public plugin inventory and scoped tool definitions; no policy toggles or schema/config dump.', onActivate: navigate(() => this.nativeUi.openInventory()) },
      { id: 'native.rename', label: 'Session title', value: this.info?.title ?? 'No title', available: capabilities.includes('session-rename'),
        description: 'Explicit native user-title rename; no replacement title generator.', onActivate: navigate(() => this.nativeUi.openRename()) },
      { id: 'native.configuration', label: 'MCP / credentials', value: 'Managed by DSH',
        description: 'No credential entry or raw profile auto-form in this TUI.', available: false },
    ]
  }

  private returnToSettings(): void {
    const pending = this.settingsReturnState
    this.settingsReturnState = undefined
    if (pending !== undefined && !this.closing && this.dialog === undefined && this.sameAttachment(pending.context)) {
      this.openSettings(pending.view)
      const feedback = this.settingsFeedback
      this.settingsFeedback = undefined
      const dialog = this.dialog as Component | undefined
      if (feedback !== undefined && this.sameAttachment(feedback.context) && dialog instanceof SettingsDialog) dialog.setMessage(feedback.message, feedback.error)
    }
  }

  private openSettings(initialState?: SettingsViewState): void {
    const dialog = new SettingsDialog(this.tui, {
      settings: this.settings.get(), initialState,
      onChange: async patch => {
        await this.settings.set(patch)
        const settings = this.settings.get()
        this.applyDisplayPreferences(settings)
        return settings
      },
      onReset: async key => {
        await this.settings.reset(key)
        const settings = this.settings.get()
        this.applyDisplayPreferences(settings)
        return settings
      },
      onKeybindings: () => { this.openKeybindings() },
      getNativeEntries: () => this.settingsNativeEntries(),
      keymap: this.keymap, screen: this.screen, path: this.settings.path,
      onCancel: () => { this.settingsReturnState = undefined; this.dismissDialog() },
      onInterrupt: () => { void this.interrupt() },
    })
    this.showDialog(dialog)
    void this.queryAutoTitle()
    void this.refreshSkills()
    this.nativeUi.refreshSettings()
  }

  private openKeybindings(): void {
    const previous = this.dialog instanceof SettingsDialog ? this.dialog.captureView() : undefined
    const context = this.context()
    const dialog = new KeybindingsDialog(this.tui, {
      keymap: this.keymap, path: this.keybindings.path,
      onChange: (id, bindings) => this.saveKeybinding(id, bindings),
      onBack: () => { if (this.dialog === dialog && this.sameAttachment(context)) this.openSettings(previous) },
      onInterrupt: () => { void this.interrupt() },
    })
    this.showDialog(dialog)
  }

  private openQueue(): void {
    if (!this.connected || !this.info?.capabilities.includes('state')) {
      this.store.report('The native inbox view is unavailable in this runtime.')
      return
    }
    const context = this.context()
    const dialog = new QueueDialog(this.tui, {
      getEntries: () => this.sameAttachment(context) ? this.queueRows : [], keymap: this.keymap,
      onEdit: entry => {
        if (this.dialog !== dialog || !this.sameAttachment(context)) throw new Error('The native inbox attachment changed.')
        if (entry.images > 0) throw new Error('Recover image references with Up on an empty prompt before editing this native queued message.')
        this.dismissDialog(); this.editQueued(entry.messageId)
      },
      onCancelEntry: async entry => { if (!this.sameAttachment(context)) throw new Error('The native inbox attachment changed.'); await this.cancelQueued(entry.messageId, true) },
      onSendNow: async entry => { if (!this.sameAttachment(context)) throw new Error('The native inbox attachment changed.'); await this.sendQueued(entry.messageId, true) },
      onClose: () => { if (this.dialog === dialog) this.dismissDialog() },
      onInterrupt: () => { void this.interrupt() }, onRenderRequest: () => this.render(),
    })
    this.showDialog(dialog)
    void this.refreshQueue()
  }

  private async saveKeybinding(id: string, bindings: string[] | null | undefined): Promise<void> {
    if (!this.keymap.getAction(id)) throw new Error('Unknown keyboard action')
    await this.keybindings.set(id, bindings, (next, previous) => {
      const preview = (config: CcKeymapConfig) => createCcKeymap({
        definitions: this.keymap.definitions, chordTimeoutMs: this.keymap.getChordTimeoutMs(),
        bindings: { ...this.modeBindings, ...config },
      })
      const candidate = preview(next)
      const error = candidate.getDiagnostics().find(diagnostic => diagnostic.severity === 'error')
      if (error) throw new Error(error.message)
      const existing = new Set(preview(previous).getConflicts().map(diagnostic => diagnostic.message))
      const conflict = candidate.getConflicts().find(diagnostic => !existing.has(diagnostic.message))
      if (conflict) throw new Error('Shortcut conflict: ' + conflict.message)
    })
    if (!this.reloadKeys()) throw new Error('Saved bindings could not be applied; check keybindings.json.')
  }

  /**
   * Reload TUI resources and DSH's native profile generation without
   * recreating the Agent, transcript, editor, draft or caches. Pi's reload
   * has the same boundary: resources/configuration, not core source code.
   */
  private async reloadRuntime(): Promise<void> {
    if (this.isBusy || this.queued > 0 || this.decisions.length > 0) {
      this.store.report('Reload deferred: wait for the current turn/command/queued input or resolve the pending DSH decision first.')
      return
    }
    const context = this.context()
    const beforeSettings = this.settings.get()
    const settingsWarnings = this.settings.reload()
    const settings = this.settings.get()
    this.applyDisplayPreferences(settings)
    const keysApplied = this.reloadKeys()
    const lines: string[] = ['TUI reloaded: settings and keybindings.']
    if (settings.screen !== beforeSettings.screen) lines.push('Screen change applies on the next launch.')
    for (const warning of settingsWarnings) lines.push(warning)
    if (!keysApplied) lines.push('Keybindings were not applied; see the error above.')

    let failed = false
    try {
      const result = object(await this.options.backend.command('reload'))
      if (!result) throw new Error('the backend returned no reload result')
      if (!this.sameContext(context)) return
      if (result.demo === true) {
        lines.push('Demo backend: DSH configuration reload is not applicable.')
      } else if (result.available !== true) {
        lines.push('DSH reload is unavailable in this runtime; restart required for configuration changes.')
      } else {
        const warnings = Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : []
        const pending = Array.isArray(result.pending) ? result.pending : []
        const restartReason = typeof result.restartReason === 'string' ? result.restartReason : ''
        for (const warning of warnings) lines.push(warning)
        if (pending.length > 0) lines.push('Changed plugin modules require a restart before their new code runs: ' + pending.length + '.')
        if (restartReason !== '') lines.push('Restart required: ' + restartReason + '.')
        // Never claim every plugin/config module is live when the native HMR
        // result still reports pending modules or another restart reason.
        if (pending.length > 0 || restartReason !== '') {
          lines.push('DSH configuration was reconciled, but not all native changes are running yet; restart to load the remaining plugins/configuration.')
        } else if (keysApplied && settingsWarnings.length === 0) {
          lines[0] = 'Reloaded settings, keybindings and DSH configuration.'
        } else {
          // Keep the partial outcome explicit if local resources were not applied.
          lines.push('DSH configuration and plugins reconciled.')
        }
        this.catalogRequest = undefined
        await this.refreshCommands()
        void this.queryAutoTitle()
      }
    } catch (error) {
      failed = true
      lines.push('DSH configuration was not reloaded: ' + errorText(error))
    }
    this.store.report(lines.join('\n'), failed ? 'error' : 'info')
    this.render()
  }

  private reloadKeys(): boolean {
    let applied = false
    try {
      this.keymap.setBindings({ ...this.modeBindings, ...this.keybindings.read() })
      this.viewOptions.hints = this.viewHints()
      this.viewOptions.imageDetailsHint = this.keymap.getBindings('app.images.details')[0]
      this.transcript.invalidate()
      const diagnostics = this.keymap.getDiagnostics()
      applied = !diagnostics.some(diagnostic => diagnostic.severity === 'error')
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity !== 'error') continue
        const warning = 'Keybinding: ' + diagnostic.message
        this.warnings.push(warning); this.store.report(warning, 'error')
      }
    } catch (error) {
      const warning = 'Keybindings not applied: ' + errorText(error)
      this.warnings.push(warning); this.store.report(warning, 'error')
    }
    this.render()
    return applied
  }

  private async watchKeys(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.watcher = watch(this.directory, (_, filename) => { if (filename?.toString() === 'keybindings.json') this.reloadKeys() })
      this.watcher.unref()
    } catch (error) { this.store.report('Keybinding watch unavailable: ' + errorText(error), 'error') }
  }

  /** Explicit local frontend input; bytes immediately enter the native store, never history. */
  private async attachLocalFile(argument: string): Promise<void> {
    if (argument.trim() === '') {
      const context = this.context()
      let dialog: DecisionDialog
      dialog = new DecisionDialog(this.tui, {
        request: { id: 'local-file-input', kind: 'question', title: 'Attach local file',
          questions: [{ id: 'path', question: 'Local file path (relative to this workspace)', options: [] }] },
        keymap: this.keymap, onCancel: () => this.dismissDialog(), onInterrupt: () => { void this.interrupt() },
        onSubmit: value => {
          if (this.dialog !== dialog || !this.sameAttachment(context)) return
          const answer = object(value), values = answer?.answers
          if (answer?.cancelled === true) { this.dismissDialog(); return }
          if (!Array.isArray(values) || typeof values[0] !== 'string' || values[0].trim() === '') return
          this.dismissDialog(); void this.attachLocalFile(values[0])
        },
      })
      this.showDialog(dialog); return
    }
    if (this.fileAttachController !== undefined) { this.store.report('Wait for the current local file input to finish.'); return }
    const stage = this.options.backend.stageFile
    if (stage === undefined) { this.store.report('Native file staging is unavailable in this backend.', 'error'); return }
    const context = this.context(), editor = context.editor
    const text = editor.getText(), generation = this.inputGeneration
    const controller = new AbortController()
    this.fileAttachController = controller; this.render()
    try {
      const input = await readLocalFileInput(argument, this.options.cwd, controller.signal)
      if (controller.signal.aborted || !this.sameAttachment(context)) return
      const ref = asFileAttachmentRef(await stage.call(this.options.backend, input, controller.signal))
      if (controller.signal.aborted || !this.sameAttachment(context)) return
      if (ref === undefined) throw new Error('DSH returned an invalid staged file reference.')
      if (this.inputGeneration !== generation || editor.getText() !== text || editor.isPasting()) {
        this.store.report('The file was staged by DSH, but your newer draft was not changed. Use /attach again when ready.'); return
      }
      editor.insertFile({ type: 'file', attachment: ref })
      this.store.report('Attached ' + oneLine(sanitize(ref.name), 120) + ' through native DSH storage.')
    } catch (error) {
      if (!controller.signal.aborted && this.sameAttachment(context)) this.store.report('File input: ' + errorText(error), 'error')
    } finally {
      if (this.fileAttachController === controller) this.fileAttachController = undefined
      this.render()
    }
  }

  private async pasteClipboard(): Promise<void> {
    // A native read is already in flight; don't duplicate OS work on key repeat.
    if (this.clipboardPending) return
    const context = this.context()
    const generation = this.clipboardGeneration
    const current = () => generation === this.clipboardGeneration && this.sameContext(context)
    this.clipboardPending = true
    this.render()
    try {
      const clipboard = this.options.clipboard ?? getNativeClipboard()
      if (!clipboard) { this.store.report('Native clipboard unavailable; use terminal paste.', 'error'); return }
      const bytes = await clipboard.getImage()
      if (!current()) return
      if (bytes !== undefined && bytes !== null) {
        const mediaType = imageMediaTypeFromBytes(bytes)
        if (mediaType === undefined) {
          this.store.report('Clipboard image format is not recognized. Use PNG, JPEG, GIF or WebP.', 'error')
          return
        }
        // The single Editor enforces its memory budget; DSH owns image admission.
        // There is no longer an IPC/base64-frame limit in the same-process path.
        context.editor.insertImage({ type: 'image', mediaType, data: Buffer.from(bytes).toString('base64') })
        return
      }
      const text = await clipboard.getText()
      if (!current()) return
      if (!text) { this.store.report('No image or text in the clipboard.'); return }
      context.editor.handleInput('\x1b[200~' + text + '\x1b[201~')
    } catch (error) { if (current()) this.store.report('Clipboard: ' + errorText(error), 'error') }
    finally {
      if (generation === this.clipboardGeneration) { this.clipboardPending = false; this.render() }
    }
  }

  private async externalEditor(): Promise<void> {
    if (this.terminalPaused || this.closing) return
    const context = this.context()
    let directory: string | undefined
    const previous = context.editor.captureDraftForExternalEditor()
    try {
      directory = await mkdtemp(join(tmpdir(), 'dsh-tui-edit-'))
      const file = join(directory, 'prompt.txt')
      await writeFile(file, previous.text, { mode: 0o600 })
      if (this.closing) return
      this.terminalPaused = true
      this.terminalIntegration.pause()
      this.tui.stop({ preserveScreen: true })
      const command = process.env.VISUAL || process.env.EDITOR || 'nano'
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', command, file] : ['-c', command + ' "$1"', 'editor', file], { stdio: 'inherit' })
        this.editorChild = child
        child.once('error', reject)
        child.once('exit', code => { if (this.editorChild === child) this.editorChild = undefined; resolve(code ?? 1) })
      })
      if (code === 0 && !this.closing) {
        const text = await readFile(file, 'utf8')
        // Drop the edit when the editor/session/route changed while the child ran.
        if (this.sameContext(context)) context.editor.applyExternalEdit(text, previous.snapshot)
      } else if (code !== 0 && !this.closing) this.store.report('External editor exited with code ' + code, 'error')
    } catch (error) { if (!this.closing && this.sameContext(context)) this.store.report('External editor: ' + errorText(error), 'error') }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true })
      this.terminalPaused = false
      if (!this.closing && !this.terminalRestored) {
        this.tui.start(); this.syncTerminalPresentation(); this.terminalIntegration.resume()
        this.tui.setFocus(this.dialog ?? this.prompt); this.render(); this.tui.requestRender(true)
      }
    }
  }

  private suspend(): void {
    if (process.platform === 'win32' || (this.options.registerSignals === false && this.options.allowSuspend !== true)) { this.store.report('Suspend is unavailable in this terminal'); return }
    this.terminalPaused = true
    this.terminalIntegration.pause()
    this.tui.stop({ preserveScreen: true })
    const resume = () => {
      this.terminalPaused = false
      if (!this.closing && !this.terminalRestored) {
        this.tui.start(); this.syncTerminalPresentation(); this.terminalIntegration.resume()
        this.render(); this.tui.requestRender(true)
      }
    }
    process.once('SIGCONT', resume); this.signals.push(['SIGCONT', resume])
    process.kill(process.pid, 'SIGTSTP')
  }

  /** Native plugin disposal restores the terminal synchronously before slow cleanup. */
  restoreTerminal(): void {
    if (this.terminalRestored) return
    this.terminalRestored = true
    try { this.terminalIntegration.dispose() } catch { /* terminal may already be gone */ }
    try { this.tui.terminal.setProgress(false) } catch { /* terminal may already be gone */ }
    if (!this.terminalPaused) {
      try { this.tui.stop() } catch { /* best effort; Pi also registers an exit restore hook */ }
    }
  }

  /** Terminate a foreground external editor so shutdown cannot stay raw/hung. */
  private async stopExternalEditor(): Promise<void> {
    const child = this.editorChild
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        resolve()
      }, 2_000)
      timer.unref()
      child.once('exit', () => { clearTimeout(timer); resolve() })
      try { child.kill('SIGTERM') } catch { clearTimeout(timer); resolve() }
    })
  }

  /** Bounded native close; the terminal is already restored when this runs. */
  private async closeBackendBounded(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined
    const closed = Promise.resolve(this.options.backend.close()).then(() => true, () => false)
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), SHUTDOWN_CLOSE_MS); timer.unref() })
    const ok = await Promise.race([closed, timeout])
    if (timer) clearTimeout(timer)
    return ok
  }

  async shutdown(code = 0): Promise<void> {
    // Reentry must join cleanup, not pretend the App is already quiescent.
    // The first invocation still owns the requested exit code.
    if (this.closing) { await this.exited; return }
    this.closing = true
    let outcome = code !== 0 ? code : (this.fatal ? 1 : 0)
    // Detach input synchronously, then let the supplied native host arm its
    // whole-tree deadline before any editor/backend/UI persistence await.
    this.restoreTerminal()
    this.resolveExitRequested(outcome)
    try {
      this.clipboardGeneration += 1; this.clipboardPending = false
      this.skillAutocompleteIntent = undefined
      this.catalogRequest = undefined
      this.modelCatalogRequest = undefined
      this.presetPicker = undefined; this.presetCatalogRequest = undefined
      this.nativeUi.dispose()
      this.fileAttachController?.abort(); this.fileAttachController = undefined
      this.autocomplete?.provider.dispose(); this.autocomplete = undefined
      this.invalidateSkills(); this.skillsRequest = undefined
      this.queueReadController?.abort(); this.queueReadController = undefined
      this.queuedAttachmentRecoveries.clear()
      this.closeImageDetails()
      this.closeToolDetails()
      this.closeSubagentSurfaces()
      this.clearSubagentReplyTarget()
      resetImageDisplayCache()
      this.transcript.dispose()
      this.statusDockStack.dispose()
      this.subagentProgress.dispose()
      this.todoBoard.dispose(); this.goalProgress.status = undefined
      this.stopSpinner()
      if (this.exitTimer) clearTimeout(this.exitTimer)
      if (this.titleTimer !== undefined) { clearTimeout(this.titleTimer); this.titleTimer = undefined }
      if (this.gitTimer !== undefined) { clearInterval(this.gitTimer); this.gitTimer = undefined }
      this.gitRefresher?.dispose()
      this.editor.setKeymap(this.keymap)
      this.watcher?.close(); this.off?.(); this.offInput?.(); this.offTerminalFocus?.()
      const dialog = this.dialog
      this.hideDialog()
      disposeComponent(dialog)
      disposeComponent(this.editor)
      await this.stopExternalEditor()
      try {
        if (!await this.closeBackendBounded() && outcome === 0) outcome = 1
      } catch { if (outcome === 0) outcome = 1 }
      await Promise.allSettled([
        this.settings.flush(),
        this.keybindings.flush(),
        ...[...this.histories.values()].map(history => history.flush()),
      ])
      await this.tui.terminal.drainInput().catch(() => {})
    } catch {
      if (outcome === 0) outcome = 1
    } finally {
      this.restoreTerminal()
      // Keep signal handlers through cleanup so repeated signals join it.
      for (const [signal, handler] of this.signals) process.off(signal, handler)
      this.resolveExit(outcome)
    }
  }
}
