import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  CombinedAutocompleteProvider, Container, getNativeClipboard, isViewportTUI,
  matchesKey, ProcessTerminal, ScrollView, Text, truncateToWidth, visibleWidth,
  type Component, type Focusable, type KeyId, type Terminal, type TUI,
  TuiAltScreen, TuiMainScreen, VStack,
} from '@earendil-works/pi-tui'
import type { Backend, BackendEvent, DecisionOption, DecisionRequest, SessionInfo, TranscriptCodec } from './backend/types.ts'
import { configDirectory, KeybindingsStore, PromptHistory, SettingsStore } from './config.ts'
import { HistorySearch } from './history-search.ts'
import { CcEditor, createCcKeymap, type CcActionEvent, type CcDraftSnapshot, type CcKeymap, type CcKeymapConfig } from './input/index.ts'
import { formatElapsed, formatOutputRate, formatOutputTokens, OutputTracker } from './state/output-stats.ts'
import { TranscriptStore } from './state/transcript.ts'
import { DecisionDialog, SelectDialog } from './ui/dialogs.ts'
import { KeybindingsDialog } from './ui/keybindings.ts'
import { TranscriptView } from './ui/transcript.ts'
import { editorTheme, t } from './ui/theme.ts'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
// DSH mist-blue accent (not the previous CC orange).
const accent = (text: string) => t.dshBlue(text)
const dim = (text: string) => '\x1b[2m' + text + '\x1b[22m'
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const UI_COMMANDS = [
  { name: 'help', description: 'Commands and shortcuts' },
  { name: 'settings', description: 'TUI preferences' },
  { name: 'model', description: 'Choose a DSH model' },
  { name: 'effort', description: 'Choose the model reasoning effort' },
  { name: 'preset', description: 'Choose a DSH agent preset' },
  { name: 'resume', description: 'Resume a DSH session' },
  { name: 'new', description: 'New DSH session' },
  { name: 'reload', description: 'Reload TUI settings/keybindings and DSH configuration/plugins' },
  { name: 'exit', description: 'Exit' },
]

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
    return this.borderColor('── ') + status + this.borderColor(' ' + '─'.repeat(Math.max(0, width - statusWidth - 4)))
  }

  render(width: number): string[] {
    const lines = super.render(width)
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
  demo?: boolean
  initialPrompt?: string
  continueLatest?: boolean
  registerSignals?: boolean
}

export class App {
  readonly tui: TUI
  readonly store = new TranscriptStore()
  readonly exited: Promise<number>
  readonly keymap: CcKeymap
  private resolveExit!: (code: number) => void
  private readonly options: AppOptions
  private readonly settings: SettingsStore
  private readonly keybindings: KeybindingsStore
  private readonly directory: string
  private readonly screen: 'inline' | 'fullscreen'
  private readonly modeBindings: CcKeymapConfig
  private history: PromptHistory
  private readonly histories = new Map<string, PromptHistory>()
  private readonly viewOptions: { showThinking: boolean; expandTools: boolean }
  private readonly transcript: TranscriptView
  private readonly prompt: Prompt
  private readonly slot = new Container()
  private readonly footer = new Text('', 0, 0)
  private readonly hint = new Text('', 0, 0)
  private readonly bottom = new Container()
  private info?: SessionInfo
  private busy = false
  private connected = false
  private fatal = false
  private closing = false
  private terminalPaused = false
  private off?: () => void
  private dialog?: Component
  private decisionId?: string
  private readonly decisions: Array<{ sessionId: string; request: DecisionRequest }> = []
  private readonly activeCommands = new Map<string, string>()
  private nativeCommands: Array<{ name: string; description: string }> = []
  private catalogRequest?: { sessionId: string; promise: Promise<void> }
  private codec?: TranscriptCodec
  private stashed?: CcDraftSnapshot
  private cleared?: CcDraftSnapshot
  private restored?: { text: string; before: CcDraftSnapshot }
  private updatingDraft = false
  private queueRecallPending = false
  private nextSendMode?: 'followup' | 'steer'
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
      'app.message.sendNow': ['ctrl+enter', 'ctrl+x ctrl+s'],
      'app.message.followUp': ['ctrl+x enter'],
    }
    this.keymap = createCcKeymap({ bindings: this.modeBindings, chordTimeoutMs: 3000 })
    this.viewOptions = { showThinking: settings.showThinking, expandTools: settings.expandTools }
    const terminal = options.terminal ?? new ProcessTerminal()
    this.tui = this.screen === 'fullscreen'
      ? new TuiAltScreen(terminal, false, undefined, { scrollToEndIndicator: () => accent(' ↓ new output · click to follow '), copyOnSelect: true })
      : new TuiMainScreen(terminal)
    this.prompt = new Prompt(this.tui, this.keymap)
    this.transcript = new TranscriptView(this.store, this.viewOptions)
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
  }

  get editor(): CcEditor { return this.prompt.editor }
  get session(): SessionInfo | undefined { return this.info }
  get isBusy(): boolean { return this.busy || this.activeCommands.size > 0 }
  get pendingDecisionCount(): number { return this.decisions.length }

  async start(): Promise<void> {
    this.reloadKeys()
    this.configureEditor()
    this.slot.addChild(this.prompt)
    for (const item of [this.slot, this.hint, this.footer]) this.bottom.addChild(item)
    const header = new Text(accent('DeepSeek Harness') + dim(' · DSH TUI · v0.1 prototype' + (this.options.demo ? ' · DEMO / NO MODEL CALLS' : '')), 0, 1)
    const document = new Container()
    document.addChild(header)
    document.addChild(this.transcript)
    if (isViewportTUI(this.tui)) {
      this.tui.setLayoutRoot(new VStack([
        { component: new ScrollView(document, { follow: 'end', primary: true }), basis: 0, grow: 1, minSize: 1 },
        { component: this.bottom, basis: 'auto', shrink: 1, minSize: 4 },
      ]))
    } else { this.tui.addChild(document); this.tui.addChild(this.bottom) }
    this.store.onChange = () => this.render()
    this.off = this.options.backend.onEvent(event => this.onEvent(event))
    this.tui.setFocus(this.prompt)
    this.tui.start()
    this.tui.terminal.setTitle('dsh-tui · ' + basename(this.options.cwd))
    if (this.options.registerSignals !== false) {
      for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
        const handler = () => { void this.shutdown(0) }
        process.on(signal, handler); this.signals.push([signal, handler])
      }
    }
    this.render()
    await this.watchKeys()
    try {
      const info = await this.options.backend.connect()
      if (this.closing) return
      this.applyInfo(info)
      await this.refreshCommands()
      for (const warning of [...this.warnings, ...this.settings.warnings, ...this.history.warnings]) this.store.report(warning, 'error')
      if (this.options.continueLatest) await this.continueLatest()
      if (this.options.initialPrompt) await this.submit(this.options.initialPrompt)
    } catch (error) {
      this.connected = false; this.fatal = true
      this.store.report('Could not start DSH: ' + errorText(error), 'error')
    }
    this.render()
  }

  private commands(): Array<{ name: string; description: string }> {
    const commands = [...UI_COMMANDS]
    const names = new Set(commands.map(command => command.name))
    for (const command of this.nativeCommands) if (!names.has(command.name)) { commands.push(command); names.add(command.name) }
    return commands
  }

  private updateAutocomplete(): void {
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(this.commands(), this.info?.cwd ?? this.options.cwd))
  }

  private refreshCommands(): Promise<void> {
    const sessionId = this.info?.sessionId
    if (!sessionId || !this.info?.capabilities.includes('commands')) {
      this.nativeCommands = []; this.updateAutocomplete(); return Promise.resolve()
    }
    if (this.catalogRequest?.sessionId === sessionId) return this.catalogRequest.promise
    const promise = (async () => {
      try {
        const result = await this.options.backend.command('commands')
        if (this.closing || this.info?.sessionId !== sessionId) return
        this.nativeCommands = Array.isArray(result) ? result.flatMap(value => {
          const command = object(value)
          return typeof command?.name === 'string' && command.name
            ? [{ name: command.name, description: typeof command.description === 'string' ? command.description : '' }] : []
        }) : []
        this.updateAutocomplete()
      } catch (error) {
        if (!this.closing && this.info?.sessionId === sessionId) this.store.report('Could not read DSH commands: ' + errorText(error), 'error')
      }
    })()
    this.catalogRequest = { sessionId, promise }
    void promise.finally(() => { if (this.catalogRequest?.promise === promise) this.catalogRequest = undefined })
    return promise
  }

  private configureEditor(): void {
    for (const text of this.history.entries()) this.editor.addToHistory(text)
    this.updateAutocomplete()
    this.editor.onChange = () => {
      if (!this.updatingDraft && this.restored && this.editor.getExpandedText() !== this.restored.text) this.restored = undefined
      this.exitArm = undefined
      this.render()
    }
    this.editor.onSubmit = text => { const mode = this.nextSendMode ?? 'followup'; this.nextSendMode = undefined; void this.submit(text, mode) }
    this.editor.onAction = event => this.dispatchAction(event)
    this.editor.onChordChange = prefix => { this.chordHint = prefix ?? undefined; this.render() }
    this.prompt.onKey = data => this.beforeInput(data)
    this.prompt.focused = this.prompt.focused
  }

  private applyInfo(info: SessionInfo): void {
    const codec = this.options.backend.transcriptCodec
    if (codec && codec !== this.codec) { this.store.setCodec(codec); this.codec = codec }
    const changed = this.info?.sessionId !== info.sessionId || this.info?.attachmentId !== info.attachmentId
    this.info = info; this.connected = true
    if (changed) {
      this.nextPreset = undefined
      this.decisions.length = 0; this.activeCommands.clear(); this.nativeCommands = []
      this.hideDialog()
      this.busy = false; this.stopSpinner(); this.output.reset()
      this.store.reset(info)
      if (info.truncated) this.store.report('Showing recent history only (' + (info.events?.length ?? 0) + '/' + (info.totalEvents ?? '?') + ' events); the full DSH log remains intact.')
      this.stashed = undefined; this.cleared = undefined; this.restored = undefined
      let history = this.histories.get(info.cwd)
      if (!history) { history = new PromptHistory(info.cwd, this.directory); this.histories.set(info.cwd, history) }
      this.history = history
      this.prompt.editor = new PromptEditor(this.tui, editorTheme, { paddingX: 2, keymap: this.keymap })
      this.configureEditor()
      void this.refreshCommands()
    }
    this.render()
  }

  private onEvent(event: BackendEvent): void {
    if (this.closing) return
    if (event.type === 'ready') { this.applyInfo(event.info); return }
    this.store.handle(event)
    if ('sessionId' in event && event.sessionId !== this.info?.sessionId) return
    if (event.type === 'status') {
      this.busy = event.status === 'running'
      if (this.isBusy) this.startSpinner(); else this.stopSpinner()
    } else if (event.type === 'stream_start') {
      this.output.start(event.turn, event.attemptId)
    } else if (event.type === 'stream_chunk') {
      this.output.chunk(event.attemptId, event.chunk)
    } else if (event.type === 'permissions' && this.info) {
      this.info.permissions = event.value
    } else if (event.type === 'session_event' && event.event.type === 'turn/start') {
      const data = object(event.event.data)
      this.output.beginTurn(typeof data?.turn === 'number' ? data.turn : undefined, Date.now())
    } else if (event.type === 'session_event' && (event.event.type === 'command/run' || event.event.type === 'command/done')) {
      const data = object(event.event.data)
      if (typeof data?.commandId === 'string') {
        if (event.event.type === 'command/run') this.activeCommands.set(data.commandId, typeof data.name === 'string' ? data.name : 'command')
        else this.activeCommands.delete(data.commandId)
      }
      if (this.isBusy) this.startSpinner(); else this.stopSpinner()
    } else if (event.type === 'decision') {
      if (!this.decisions.some(pending => pending.request.id === event.request.id)) this.decisions.push({ sessionId: event.sessionId, request: event.request })
      this.showNextDecision()
    } else if (event.type === 'decision_closed') this.closeDecision(event.id)
    else if (event.type === 'closed' || (event.type === 'error' && event.fatal)) {
      this.connected = false; this.busy = false; this.decisions.length = 0; this.activeCommands.clear(); this.stopSpinner(); this.output.reset(); this.hideDialog()
      if (event.type === 'error' || (event.code !== null && event.code !== 0)) this.fatal = true
    }
    this.render()
  }

  /** The status text embedded in the editor's top border. */
  private workingStatus(spinner: string, command: string | undefined, now: number): string {
    const label = this.busy ? 'Working…' : '/' + (command ?? 'command') + '…'
    const details = this.workingDetails(this.busy, now)
    return accent(spinner + ' ' + label) + (details === '' ? '' : dim(' (' + details + ')')) + dim(' · Esc interrupt')
  }

  /**
   * `↓ 186 tokens · 9s · 21 tok/s` for a model turn. Native commands have no
   * output-token stream, so they show only elapsed time after the same 3s
   * threshold Pi uses.
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
    if (tokens > 0) {
      const rate = formatOutputRate(this.output.rate(now))
      if (rate !== '') parts.push(rate)
    }
    return parts.join(' · ')
  }

  private startSpinner(): void {
    if (this.spinner) return
    this.startedAt = Date.now()
    this.spinner = setInterval(() => { this.spinnerStep++; this.render() }, 100)
    this.spinner.unref()
  }
  private stopSpinner(): void { if (this.spinner) clearInterval(this.spinner); this.spinner = undefined }

  private render(): void {
    if (this.closing || this.terminalPaused) return
    const spinner = ['·', '✻', '✶', '✳'][this.spinnerStep % 4]
    const command = this.activeCommands.values().next().value
    this.prompt.setWorkingStatus(this.isBusy ? this.workingStatus(spinner, command, Date.now()) : '')
    const hint = this.exitArm ? 'Press the same exit key again to exit'
      : this.chordHint ? this.chordHint.join(' ') + ' …'
      : this.decisionId ? 'Decision 1/' + this.decisions.length + ' · Ctrl+P/N navigate · Enter choose · Esc cancel'
      : this.dialog instanceof KeybindingsDialog ? ''
      : this.dialog ? 'Ctrl+P/N navigate · Enter choose · Esc cancel'
      : ''
    // An empty Text must stay truly empty: dim('') still emits ANSI escapes,
    // which Text treats as content and renders as a visually blank row.
    this.hint.setText(hint ? dim(hint) : '')
    const model = this.info ? this.info.provider + '/' + this.info.model : 'starting DSH…'
    const status = this.isBusy ? 'working' : this.connected ? 'ready' : 'disconnected'
    const preset = this.info?.preset ? ' · preset: ' + this.info.preset : ''
    const staged = this.nextPreset ? ' · next preset: ' + this.nextPreset : ''
    const effort = this.info?.reasoningEffort ? ' · effort: ' + this.info.reasoningEffort : ''
    this.footer.setText(dim(model + ' · ' + status + preset + staged + effort + (this.info?.permissions ? ' · permission: ' + this.info.permissions.currentValue : '') + '\n' + (this.info?.cwd ?? this.options.cwd)))
    this.tui.terminal.setProgress(this.isBusy)
    this.tui.requestRender()
  }

  private showDialog(dialog: Component, decision = false): void {
    if (this.decisionId && !decision) { this.store.report('Resolve the pending DSH decision before opening another dialog.'); return }
    this.keymap.cancelChord(); this.chordHint = undefined
    this.dialog = dialog
    this.slot.clear(); this.slot.addChild(dialog)
    this.tui.setFocus(dialog); this.render()
  }
  private hideDialog(): void {
    this.keymap.cancelChord(); this.chordHint = undefined
    this.dialog = undefined; this.decisionId = undefined
    this.slot.clear(); this.slot.addChild(this.prompt)
    this.tui.setFocus(this.prompt)
    this.showNextDecision(); this.render()
  }

  private showNextDecision(): void {
    if (this.closing || this.decisionId || !this.connected) return
    const pending = this.decisions.find(decision => decision.sessionId === this.info?.sessionId)
    if (!pending) return
    const request = pending.request
    this.decisionId = request.id
    this.showDialog(new DecisionDialog(this.tui, {
      request,
      onSubmit: value => { void this.answer(request.id, value) },
      onCancel: () => { void this.answer(request.id, { cancelled: true }) },
      keymap: this.keymap,
    }), true)
  }

  private closeDecision(id: string): void {
    const index = this.decisions.findIndex(decision => decision.request.id === id)
    if (index < 0) return
    this.decisions.splice(index, 1)
    if (this.decisionId === id) this.hideDialog()
    else this.render()
  }

  private async answer(id: string, value: unknown): Promise<void> {
    const pending = this.decisions.find(decision => decision.request.id === id && decision.sessionId === this.info?.sessionId)
    if (!pending || this.closing) return
    try { await this.options.backend.respond(id, value); this.closeDecision(id) }
    catch (error) { if (!this.closing) this.store.report(errorText(error), 'error') }
  }

  /** Non-mutating binding lookup: editor remains the sole key/chord dispatcher. */
  private bound(data: string, id: string): boolean {
    return this.keymap.getBindings(id).some(binding => !binding.includes(' ') && matchesKey(data, binding as KeyId))
  }

  private beforeInput(data: string): boolean {
    if (this.editor.isPasting() || data.startsWith('\x1b[200~') || this.keymap.isPendingChord() || this.editor.capturesViewportInput) return false
    const up = this.bound(data, 'editor.move.line-up') || this.bound(data, 'editor.history.previous')
    const down = this.bound(data, 'editor.move.line-down') || this.bound(data, 'editor.history.next')
    if (up && this.busy && !this.editor.getExpandedText() && this.info?.capabilities.includes('dequeue')) {
      if (!this.queueRecallPending) void this.recallQueue(data)
      return true
    }
    if (up && !this.editor.getExpandedText() && this.cleared) {
      const before = this.editor.captureDraft()
      this.updatingDraft = true; this.editor.restoreDraft(this.cleared); this.updatingDraft = false
      this.cleared = undefined
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
    const editor = this.editor
    const sessionId = this.info?.sessionId
    const before = editor.captureDraft()
    const attachmentId = this.info?.attachmentId
    const history = this.history
    try {
      const result = await this.options.backend.command('dequeue', { sessionId, attachmentId })
      const texts = Array.isArray(result) ? result.flatMap(value => {
        const message = object(value)
        return typeof value === 'string' ? [value] : typeof message?.text === 'string' ? [message.text] : []
      }) : []
      if (this.closing || this.info?.sessionId !== sessionId || this.editor !== editor) {
        for (const text of texts) void history.add(text).catch(() => {})
        return
      }
      if (editor.getText() || editor.isPasting() || this.keymap.isPendingChord()) {
        for (const text of texts) { editor.addToHistory(text); void history.add(text).catch(() => {}) }
        if (texts.length) this.store.report('Retrieved queued inputs were kept in recall history; your new draft was not replaced.')
        return
      }
      if (!texts.length) { editor.handleInput(key); return }
      this.updatingDraft = true
      editor.replaceDraftText(texts.join('\n\n'))
      this.updatingDraft = false
      this.restored = { text: editor.getExpandedText(), before }
    } catch (error) { this.store.report('Could not retrieve queue: ' + errorText(error), 'error') }
    finally { this.queueRecallPending = false; this.render() }
  }

  private dispatchAction(event: CcActionEvent): boolean {
    switch (event.id) {
      case 'app.interrupt':
        if (this.isBusy) void this.interrupt()
        else if (!event.empty) { this.cleared = this.editor.captureDraft(); this.editor.replaceDraftText('') }
        else this.armExit(event.id)
        break
      case 'app.cancel':
        if (this.isBusy) void this.interrupt()
        else {
          const now = Date.now()
          if (!event.empty && now - this.escapeAt < 400) { this.cleared = this.editor.captureDraft(); this.editor.replaceDraftText(''); this.escapeAt = 0 }
          else this.escapeAt = now
        }
        break
      case 'app.exit': this.armExit(event.id); break
      case 'app.redraw': this.tui.requestRender(true); break
      case 'app.history.search': this.searchHistory(); break
      case 'app.stash':
        if (!event.empty) { this.stashed = this.editor.captureDraft(); this.editor.replaceDraftText('') }
        else if (this.stashed) { this.editor.restoreDraft(this.stashed); this.stashed = undefined }
        break
      case 'app.tools.expand': this.viewOptions.expandTools = !this.viewOptions.expandTools; this.transcript.invalidate(); break
      case 'app.thinking.toggle': this.viewOptions.showThinking = !this.viewOptions.showThinking; this.transcript.invalidate(); break
      case 'app.model.select': void this.pick('models'); break
      case 'app.mode.cycle': void this.cyclePermission(); break
      case 'app.editor.external': void this.externalEditor(); break
      case 'app.clipboard.pasteImage': void this.pasteClipboard(); break
      case 'app.message.sendNow':
      case 'app.message.followUp':
        if (!event.empty && !this.editor.disableSubmit) { this.nextSendMode = event.id === 'app.message.sendNow' ? 'steer' : 'followup'; this.editor.ccSubmit() }
        break
      case 'app.suspend': this.suspend(); break
      case 'app.todo': this.store.report('Todo/goal panels are not included in this prototype yet.'); break
      case 'app.help': void this.slash('/help'); break
      default: this.store.report('Action is not yet integrated: ' + event.id); break
    }
    this.render()
    return true
  }

  private armExit(id: string): void {
    const now = Date.now()
    if (this.exitArm?.id === id && now - this.exitArm.at < 800) { void this.shutdown(0); return }
    this.exitArm = { id, at: now }
    this.render()
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.exitTimer = setTimeout(() => { this.exitArm = undefined; this.render() }, 800)
    this.exitTimer.unref()
  }

  private searchHistory(): void {
    const original = this.editor.captureDraft()
    this.showDialog(new HistorySearch(this.tui, this.history.entries(), this.keymap, this.screen, (text, execute) => {
      this.hideDialog()
      this.editor.restoreDraft(original)
      if (text !== undefined) this.editor.replaceDraftText(text)
      if (execute && text?.trim()) { this.editor.replaceDraftText(''); void this.submit(text) }
      this.render()
    }))
  }

  async submit(text: string, mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    if (!text.trim() || this.closing) return
    if (text.startsWith('/')) { await this.slash(text); return }
    if (!this.connected) { this.editor.replaceDraftText(text); this.store.report('DSH is disconnected. Check the error above, then restart.', 'error'); return }
    const sessionId = this.info?.sessionId
    const editor = this.editor
    const history = this.history
    const draftBeforeSend = editor.getText()
    try { await this.options.backend.send(text, mode) }
    catch (error) {
      if (!this.closing && this.info?.sessionId === sessionId && this.editor.getText() === draftBeforeSend) this.editor.replaceDraftText(text)
      this.store.report('Prompt not accepted: ' + errorText(error), 'error')
      this.render(); return
    }
    if (!this.closing && this.info?.sessionId === sessionId && this.editor === editor) { editor.addToHistory(text); this.restored = undefined }
    void history.add(text).catch(error => { if (!this.closing) this.store.report('Prompt accepted, but recall history was not saved: ' + errorText(error), 'error') })
    this.render()
  }

  async interrupt(): Promise<void> {
    try { await this.options.backend.cancel() }
    catch (error) { this.store.report(errorText(error), 'error') }
  }

  private async slash(text: string): Promise<void> {
    // Only UI-owned commands are parsed here. Native input is forwarded without
    // changing whitespace, multiline arguments, audit text or validation rules.
    const matched = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text)
    const name = matched?.[1]?.toLowerCase() ?? ''
    const argument = matched?.[2]?.trim() ?? ''
    if (name === 'exit' || name === 'quit') { await this.shutdown(0); return }
    if (name === 'help') { await this.refreshCommands(); this.store.report(this.commands().map(command => '/' + command.name + ' — ' + command.description).join('\n')); return }
    if (name === 'reload') { await this.reloadRuntime(); return }
    if (name === 'settings' || name === 'config') { this.openSettings(); return }
    if (name === 'model') { if (argument) await this.runRemote('model', { id: argument }); else await this.pick('models'); return }
    if (name === 'effort') { await this.effortCommand(argument); return }
    if (name === 'preset') { await this.presetCommand(argument); return }
    if (name === 'resume') { if (argument) await this.runRemote('resume', { sessionId: argument }); else await this.pick('sessions'); return }
    if (name === 'new' || name === 'clear') {
      await this.runRemote('new', this.nextPreset === undefined ? undefined : { preset: this.nextPreset }); return
    }
    if (!this.connected) { this.store.report('DSH is disconnected.', 'error'); return }
    if (!this.info?.capabilities.includes('execute')) { this.store.report('Native DSH command execution is unavailable in this runtime.', 'error'); return }
    await this.runRemote('execute', { line: text })
  }

  private async cyclePermission(): Promise<void> {
    const sessionId = this.info?.sessionId, attachmentId = this.info?.attachmentId
    try {
      if (!this.info?.capabilities.includes('permissions') || !this.info.capabilities.includes('execute')) {
        throw new Error('This backend does not expose native permission switching')
      }
      const current = object(await this.options.backend.command('permissions'))
      if (this.closing || this.info?.sessionId !== sessionId || this.info?.attachmentId !== attachmentId) return
      const options = Array.isArray(current?.options) ? current.options.map(object).filter(item => typeof item?.value === 'string') : []
      if (!options.length) throw new Error('This backend has no selectable permission presets')
      const index = options.findIndex(item => item?.value === current?.currentValue)
      const next = options[(index + 1) % options.length]
      await this.runRemote('execute', { line: '/permission ' + next?.value })
    } catch (error) { this.store.report(errorText(error), 'error') }
  }

  private async runRemote(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.info?.sessionId
    try {
      const result = await this.options.backend.command(name, args)
      if (this.closing || (!['resume', 'new'].includes(name) && this.info?.sessionId !== sessionId)) return result
      const info = object(result)
      if (info && typeof info.sessionId === 'string' && typeof info.cwd === 'string' && typeof info.provider === 'string' && typeof info.model === 'string' && Array.isArray(info.capabilities)) this.applyInfo(result as SessionInfo)
      else if ((name === 'model' || name === 'effort') && this.info && info) {
        if (typeof info.provider === 'string') this.info.provider = info.provider
        if (typeof info.model === 'string') this.info.model = info.model
        if (typeof info.reasoningEffort === 'string') this.info.reasoningEffort = info.reasoningEffort
        else delete this.info.reasoningEffort
        if (name === 'effort') this.store.report('Reasoning effort: ' + (typeof info.effectiveEffort === 'string' ? info.effectiveEffort : 'default'))
      } else if (name === 'execute' || name === 'compact') {
        const outcome = object(info?.result)
        if (outcome) {
          if (typeof outcome.text === 'string' && outcome.text) this.store.report(outcome.text, outcome.kind === 'error' ? 'error' : 'info')
        } else if (result !== undefined) this.store.report('Invalid native command outcome.', 'error')
      } else if (result !== undefined && !['state', 'models', 'sessions', 'commands', 'presets', 'efforts'].includes(name)) this.store.report(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      this.render()
      return result
    } catch (error) { this.store.report(errorText(error), 'error'); return undefined }
  }

  private async pick(kind: 'models' | 'sessions' | 'presets' | 'efforts'): Promise<void> {
    const sessionId = this.info?.sessionId
    if (kind === 'presets') { await this.pickPreset(); return }
    if (kind === 'efforts') { await this.pickEffort(); return }
    const result = await this.runRemote(kind)
    if (this.closing || this.info?.sessionId !== sessionId || !Array.isArray(result)) return
    const items: DecisionOption[] = result.flatMap(value => {
      const item = object(value)
      const id = item?.id ?? item?.sessionId
      if (!item || typeof id !== 'string') return []
      return [{ label: String(item.label ?? item.title ?? item.name ?? id), description: typeof item.cwd === 'string' ? item.cwd : id, value: id }]
    })
    if (!items.length) { this.store.report('No ' + kind + ' available'); return }
    this.showDialog(new SelectDialog(this.tui, { title: kind === 'models' ? 'Choose model' : 'Resume session', items, keymap: this.keymap,
      onSelect: value => { this.hideDialog(); void this.runRemote(kind === 'models' ? 'model' : 'resume', kind === 'models' ? { id: value } : { sessionId: value }) },
      onCancel: () => this.hideDialog(),
    }))
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

  private presetLabel(id: string, catalog: Record<string, unknown>): string {
    const entries = Array.isArray(catalog.presets) ? catalog.presets.map(object) : []
    const entry = entries.find(item => item?.id === id)
    return typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : id
  }

  private async presetCommand(argument: string): Promise<void> {
    const catalog = await this.presetCatalog()
    if (!catalog) return
    const current = typeof catalog.current === 'string' ? catalog.current : undefined
    const entries = Array.isArray(catalog.presets) ? catalog.presets.map(object).filter(item => typeof item?.id === 'string') : []
    if (argument === 'status') {
      const healthy = entries.filter(item => typeof item?.broken !== 'string')
      const lines = [
        'Agent preset: ' + (current ?? 'none'),
        'New sessions: ' + (this.nextPreset ?? (typeof catalog.default === 'string' ? catalog.default : 'roster default')),
        'Available: ' + (healthy.map(item => String(item!.id)).join(', ') || 'none'),
      ]
      this.store.report(lines.join('\n')); return
    }
    if (!argument) { await this.pickPreset(catalog); return }
    const entry = entries.find(item => item?.id === argument)
    if (!entry) {
      this.store.report('Unknown agent preset: ' + argument + '. Available: ' + (entries.map(item => String(item!.id)).join(', ') || 'none'), 'error')
      return
    }
    if (typeof entry.broken === 'string') { this.store.report('Agent preset ' + argument + ' is unavailable: ' + entry.broken, 'error'); return }
    if (catalog.blank !== true) { this.stagePreset(argument, catalog); return }
    await this.applyPreset(argument, catalog)
  }

  private stagePreset(id: string, catalog: Record<string, unknown>): void {
    this.nextPreset = id
    this.store.report('Agent preset ' + this.presetLabel(id, catalog) + ' will be used for the next /new session; this session keeps ' + (this.info?.preset ?? 'its current preset') + '.')
    this.render()
  }

  private async applyPreset(id: string, catalog: Record<string, unknown>): Promise<void> {
    const sessionId = this.info?.sessionId
    try {
      const result = object(await this.options.backend.command('preset', { id }))
      if (this.closing || this.info?.sessionId !== sessionId) return
      if (result?.locked === true) { this.stagePreset(id, catalog); return }
      if (result && typeof result.sessionId === 'string' && typeof result.cwd === 'string' && typeof result.provider === 'string' && typeof result.model === 'string' && Array.isArray(result.capabilities)) {
        this.applyInfo(result as unknown as SessionInfo)
        this.catalogRequest = undefined
        await this.refreshCommands()
        this.store.report('Agent preset: ' + this.presetLabel(id, catalog))
      }
      this.render()
    } catch (error) { this.store.report(errorText(error), 'error') }
  }

  private async pickPreset(existing?: Record<string, unknown>): Promise<void> {
    const catalog = existing ?? await this.presetCatalog()
    if (!catalog) return
    const current = typeof catalog.current === 'string' ? catalog.current : undefined
    const entries = Array.isArray(catalog.presets) ? catalog.presets.map(object).filter(item => typeof item?.id === 'string') : []
    const items: DecisionOption[] = entries.filter(item => typeof item?.broken !== 'string').map(item => {
      const id = String(item!.id)
      const label = typeof item!.name === 'string' && item!.name.length > 0 ? item!.name : id
      const marks = [id === current ? 'current' : '', item!.isDefault === true ? 'default' : '', id === this.nextPreset ? 'next' : ''].filter(Boolean)
      const detail = typeof item!.description === 'string' && item!.description.length > 0 ? item!.description : id
      return { label: label + (marks.length ? ' · ' + marks.join(' · ') : ''), description: detail, value: id }
    })
    const broken = entries.filter(item => typeof item?.broken === 'string')
    if (!items.length) { this.store.report('No usable agent presets are available' + (broken.length ? ' (' + broken.length + ' unavailable)' : ''), 'error'); return }
    if (broken.length) this.store.report('Skipped ' + broken.length + ' unavailable agent preset(s).')
    this.showDialog(new SelectDialog(this.tui, { title: 'Choose agent preset', items, keymap: this.keymap,
      onSelect: value => {
        this.hideDialog()
        const id = String(value)
        if (catalog.blank !== true) { this.stagePreset(id, catalog); return }
        void this.applyPreset(id, catalog)
      },
      onCancel: () => this.hideDialog(),
    }))
  }

  private async pickEffort(): Promise<void> {
    await this.effortCommand('')
  }

  private async effortCommand(argument: string): Promise<void> {
    if (argument && argument !== 'status') {
      await this.runRemote('effort', { id: argument === 'default' ? null : argument })
      return
    }
    const data = object(await this.runRemote('efforts'))
    if (!data) return
    const levels = Array.isArray(data.efforts) ? data.efforts.map(object).filter(item => typeof item?.id === 'string') : []
    const selected = typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined
    const effective = typeof data.effectiveEffort === 'string' ? data.effectiveEffort : undefined
    if (argument === 'status') {
      this.store.report('Reasoning effort: ' + (selected ?? (effective ? effective + ' (model default)' : 'provider default')) + '\nAvailable: ' + (levels.map(item => String(item!.id)).join(', ') || 'none'))
      return
    }
    if (data.available !== true || levels.length === 0) {
      this.store.report('This model exposes no reasoning levels.', 'error'); return
    }
    const items: DecisionOption[] = [
      { label: 'Default' + (selected === undefined ? ' · current' : ''), description: typeof data.defaultEffort === 'string' ? 'Model default (' + data.defaultEffort + ')' : 'Provider default', value: '' },
      ...levels.map(item => {
        const id = String(item!.id)
        const label = typeof item!.name === 'string' && item!.name.length > 0 ? item!.name : id
        return { label: label + (id === selected ? ' · current' : id === effective ? ' · effective' : ''), description: typeof item!.description === 'string' ? item!.description : id, value: id }
      }),
    ]
    this.showDialog(new SelectDialog(this.tui, { title: 'Choose reasoning effort', items, keymap: this.keymap,
      onSelect: value => { this.hideDialog(); void this.runRemote('effort', { id: value === '' ? null : value }) },
      onCancel: () => this.hideDialog(),
    }))
  }

  private async continueLatest(): Promise<void> {
    const result = await this.options.backend.command('sessions')
    if (!Array.isArray(result)) throw new Error('Session listing unavailable')
    const latest = result.map(object).find(item => item && item.cwd === this.options.cwd && (item.id ?? item.sessionId) !== this.info?.sessionId && typeof (item.id ?? item.sessionId) === 'string')
    if (!latest) { this.store.report('No previous session in this directory'); return }
    await this.runRemote('resume', { sessionId: latest.id ?? latest.sessionId })
  }

  private openSettings(): void {
    const settings = this.settings.get()
    const items: DecisionOption[] = [
      { label: 'Tool details: ' + (this.viewOptions.expandTools ? 'on' : 'off'), value: 'tools' },
      { label: 'Thinking: ' + (this.viewOptions.showThinking ? 'on' : 'off'), value: 'thinking' },
      { label: 'Default screen: ' + settings.screen + ' (next launch)', value: 'screen' },
      { label: 'Keyboard shortcuts', description: 'View or customize keybindings', value: 'keys' },
    ]
    this.showDialog(new SelectDialog(this.tui, { title: 'Settings · ' + this.settings.path, items, keymap: this.keymap,
      onSelect: value => {
        if (value === 'keys') { this.openKeybindings(); return }
        this.hideDialog()
        let patch: Parameters<SettingsStore['set']>[0] = {}
        if (value === 'tools') patch = { expandTools: !this.viewOptions.expandTools }
        if (value === 'thinking') patch = { showThinking: !this.viewOptions.showThinking }
        if (value === 'screen') patch = { screen: settings.screen === 'inline' ? 'fullscreen' : 'inline' }
        void this.settings.set(patch).then(() => {
          if (patch.expandTools !== undefined) this.viewOptions.expandTools = patch.expandTools
          if (patch.showThinking !== undefined) this.viewOptions.showThinking = patch.showThinking
          this.transcript.invalidate(); this.render()
        }).catch(error => this.store.report(errorText(error), 'error'))
      }, onCancel: () => this.hideDialog(),
    }))
  }

  private openKeybindings(): void {
    const dialog = new KeybindingsDialog(this.tui, {
      keymap: this.keymap, path: this.keybindings.path,
      onChange: (id, bindings) => this.saveKeybinding(id, bindings),
      onBack: () => { if (this.dialog === dialog) this.openSettings() },
    })
    this.showDialog(dialog)
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
    if (this.isBusy || this.decisions.length > 0) {
      this.store.report('Reload deferred: wait for the current turn/command/queued input or resolve the pending DSH decision first.')
      return
    }
    const beforeSettings = this.settings.get()
    const settingsWarnings = this.settings.reload()
    const settings = this.settings.get()
    this.viewOptions.expandTools = settings.expandTools
    this.viewOptions.showThinking = settings.showThinking
    this.transcript.invalidate()
    const keysApplied = this.reloadKeys()
    const lines: string[] = ['TUI reloaded: settings and keybindings.']
    if (settings.screen !== beforeSettings.screen) lines.push('Screen change applies on the next launch.')
    for (const warning of settingsWarnings) lines.push(warning)
    if (!keysApplied) lines.push('Keybindings were not applied; see the error above.')

    let failed = false
    try {
      const result = object(await this.options.backend.command('reload'))
      if (!result) throw new Error('the backend returned no reload result')
      if (result.demo === true) {
        lines.push('Demo backend: DSH configuration reload is not applicable.')
      } else if (result.available !== true) {
        lines.push('DSH reload is unavailable in this runtime; restart required for configuration changes.')
      } else {
        const warnings = Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : []
        const pending = Array.isArray(result.pending) ? result.pending : []
        for (const warning of warnings) lines.push(warning)
        if (pending.length > 0) lines.push('Changed plugin modules require a restart before their new code runs: ' + pending.length + '.')
        if (typeof result.restartReason === 'string' && result.restartReason !== '') {
          lines.push('Restart required: ' + result.restartReason + '.')
        }
        lines.push('DSH configuration and plugins reconciled; session, transcript and caches preserved.')
        lines.push('The current session keeps its mounted model/preset; changed defaults apply through /model or /new.')
        this.catalogRequest = undefined
        await this.refreshCommands()
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

  private async pasteClipboard(): Promise<void> {
    try {
      const clipboard = getNativeClipboard()
      if (!clipboard) { this.store.report('Native clipboard unavailable; use terminal paste.', 'error'); return }
      const text = await clipboard.getText()
      if (!text) { this.store.report('No clipboard text. Image attachment sending is not yet available in this prototype.'); return }
      this.editor.handleInput('\x1b[200~' + text + '\x1b[201~')
      this.render()
    } catch (error) { this.store.report('Clipboard: ' + errorText(error), 'error') }
  }

  private async externalEditor(): Promise<void> {
    if (this.terminalPaused || this.closing) return
    let directory: string | undefined
    const previous = this.editor.captureDraftForExternalEditor()
    try {
      directory = await mkdtemp(join(tmpdir(), 'dsh-pi-tui-edit-'))
      const file = join(directory, 'prompt.txt')
      await writeFile(file, previous.text, { mode: 0o600 })
      this.terminalPaused = true
      this.tui.stop({ preserveScreen: true })
      const command = process.env.VISUAL || process.env.EDITOR || 'nano'
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', command, file] : ['-c', command + ' "$1"', 'editor', file], { stdio: 'inherit' })
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1))
      })
      if (code === 0) this.editor.applyExternalEdit(await readFile(file, 'utf8'), previous.snapshot)
      else this.store.report('External editor exited with code ' + code, 'error')
    } catch (error) { this.store.report('External editor: ' + errorText(error), 'error') }
    finally {
      if (directory) await rm(directory, { recursive: true, force: true })
      this.terminalPaused = false
      if (!this.closing) { this.tui.start(); this.tui.setFocus(this.dialog ?? this.prompt); this.tui.requestRender(true) }
    }
  }

  private suspend(): void {
    if (process.platform === 'win32' || this.options.registerSignals === false) { this.store.report('Suspend is unavailable in this terminal'); return }
    this.terminalPaused = true
    this.tui.stop({ preserveScreen: true })
    const resume = () => { this.terminalPaused = false; if (!this.closing) { this.tui.start(); this.tui.requestRender(true) } }
    process.once('SIGCONT', resume); this.signals.push(['SIGCONT', resume])
    process.kill(process.pid, 'SIGTSTP')
  }

  async shutdown(code = 0): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.stopSpinner()
    if (this.exitTimer) clearTimeout(this.exitTimer)
    this.editor.setKeymap(this.keymap)
    this.watcher?.close(); this.off?.()
    for (const [signal, handler] of this.signals) process.off(signal, handler)
    let outcome = code || (this.fatal ? 1 : 0)
    try { await this.options.backend.close() } catch { outcome = 1 }
    finally {
      await Promise.allSettled([this.keybindings.flush(), ...[...this.histories.values()].map(history => history.flush())])
      this.tui.terminal.setProgress(false)
      this.tui.stop()
      await this.tui.terminal.drainInput().catch(() => {})
      this.resolveExit(outcome)
    }
  }
}
