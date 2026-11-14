/** App-only native views. No tools, domain loop, persistence, timers or profile composition. */
import type { Component, TUI } from '#pi-tui'
import type { Backend, BackendEvent, SessionInfo } from './backend/types.ts'
import { asBackendError, redactDiagnostic } from './backend/errors.ts'
import type { CcKeymap } from './input/index.ts'
import type { GoalRead, WorkingDirectoryRead } from './backend/native-inspection.ts'
import type { ContinuedQuestionRow } from './backend/native-questions.ts'
import type { DefaultSettingTarget, NativeDefaultSettingView, NativeDefaultSettingsRead } from './backend/native-management.ts'
import { DecisionDialog, SelectDialog } from './ui/dialogs.ts'
import { ModelPickerDialog, type ModelPickerItem } from './ui/model-picker.ts'
import type { InteractionPlacement } from './ui/interaction.ts'
import type { DecisionDetailContent } from './ui/decision-details.ts'
import { JobsDialog } from './ui/jobs-dialog.ts'
import { NativeInspectionDialog } from './ui/native-inspection-dialog.ts'
import { continuedQuestionChoices, continuedQuestionAnswerable, continuedQuestionsNote } from './ui/continued-questions-dialog.ts'
import { oneLine, sanitize } from './ui/text.ts'
import { readContinuedQuestions, readNativeDefaults, readNativeDirectory, readNativeGoal, readNativeJobOutput, readNativeJobs, readNativePlugins, readNativeTools } from './native-ui.ts'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const diagnostic = (error: unknown, fallback: string): string => redactDiagnostic(error instanceof Error ? error.message : fallback)

export interface NativeViewContext {
  readonly sessionId?: string
  readonly attachmentId?: string
  readonly epoch: number
  readonly editor: unknown
}

export interface NativeViewHost {
  readonly tui: TUI
  readonly keymap: CcKeymap
  readonly backend: Backend
  info(): SessionInfo | undefined
  capture(): NativeViewContext
  isCurrent(context: NativeViewContext): boolean
  dialog(): Component | undefined
  show(dialog: Component, placement?: InteractionPlacement): void
  dismiss(): void
  render(): void
  report(message: string, error?: boolean): void
  interrupt(): Promise<void>
  returnToSettings(): void
  settingsOpen(): boolean
  /** A Settings-owned result message, not a conversation notice. False = no Settings owner. */
  settingsMessage?(message: string, error?: boolean): boolean
  details?(parent: DecisionDialog, content: DecisionDetailContent): void
  goal(value: GoalRead | undefined): void
  directory(value: WorkingDirectoryRead | undefined): void
  renamed(sessionId: string, title: string): void
  sessionCommand(name: string, args: Record<string, unknown>): Promise<unknown>
}

type ViewKind = 'jobs' | 'inventory' | 'questions' | 'answer' | 'defaults' | 'default-values' | 'default-model' | 'default-effort' | 'confirm-default' | 'rename' | 'fork'
interface View {
  readonly kind: ViewKind
  readonly dialog: Component
  readonly context: NativeViewContext
  readonly generation: number
  target?: DefaultSettingTarget
  defaults?: NativeDefaultSettingsRead
  row?: ContinuedQuestionRow
}
interface Request { readonly view?: View; readonly context: NativeViewContext; readonly generation: number; dirty: boolean; promise: Promise<void> }

/** UI intent/read coalescing only. Backend/native services stay authoritative. */
export class NativeUiController {
  private readonly host: NativeViewHost
  private view?: View
  private readonly requests = new Map<string, Request>()
  private generation = 0
  private disposed = false
  defaults?: NativeDefaultSettingsRead

  constructor(host: NativeViewHost) { this.host = host }

  reset(): void {
    this.generation++
    this.requests.clear()
    this.view = undefined
    this.defaults = undefined
    this.host.goal(undefined)
    this.host.directory(undefined)
  }

  dispose(): void { if (!this.disposed) { this.disposed = true; this.reset() } }

  attached(): void {
    if (this.disposed) return
    const capabilities = this.host.info()?.capabilities ?? []
    if (capabilities.includes('native-goal')) void this.status('goal', true)
    else this.host.goal(undefined)
    if (capabilities.includes('native-working-directory')) void this.status('working-directory', true)
    else this.host.directory(undefined)
    if (this.host.settingsOpen()) this.refreshSettings()
    const view = this.view
    if (view !== undefined && this.active(view)) this.refresh(view, true)
  }

  /** The default picker has its own route provenance; session metadata must not relabel it. */
  ownsDefaultModelPicker(dialog: Component | undefined): boolean {
    return this.view?.kind === 'default-model' && this.view.dialog === dialog && this.active(this.view)
  }

  /** Catalog signals refresh existing default surfaces only, never open a picker. */
  modelsChanged(): void {
    if (this.disposed) return
    if (this.host.settingsOpen()) this.refreshSettings()
    const view = this.view
    if (view !== undefined && this.active(view) && (view.kind === 'default-model' || view.kind === 'default-effort')) this.refresh(view, true)
  }

  invalidate(event: Extract<BackendEvent, { type: 'native_ui_changed' }>): void {
    const info = this.host.info()
    if (this.disposed || info === undefined || event.sessionId !== info.sessionId ||
        (event.attachmentId !== undefined && event.attachmentId !== info.attachmentId)) return
    if (event.domain === 'goal' || event.domain === 'working-directory') { void this.status(event.domain, true); return }
    if (event.domain === 'settings' && this.host.settingsOpen()) this.refreshSettings()
    const view = this.view
    if (view === undefined || !this.active(view)) return
    if ((event.domain === 'jobs' && view.kind === 'jobs') ||
        ((event.domain === 'inventory' || event.domain === 'tools') && view.kind === 'inventory') ||
        (event.domain === 'questions' && (view.kind === 'questions' || view.kind === 'answer')) ||
        (event.domain === 'settings' && (view.kind === 'defaults' || view.kind === 'default-values' || view.kind === 'default-model' || view.kind === 'default-effort'))) this.refresh(view, true)
  }

  private active(view: View): boolean {
    return !this.disposed && this.view === view && view.generation === this.generation &&
      this.host.dialog() === view.dialog && this.host.isCurrent(view.context)
  }

  private mount(kind: ViewKind, dialog: Component, context = this.host.capture()): View | undefined {
    if (this.disposed || !this.host.isCurrent(context)) return undefined
    const view: View = { kind, dialog, context, generation: this.generation }
    const placement: InteractionPlacement = kind === 'answer' ||
      ((kind === 'rename' || kind === 'fork') && !this.host.settingsOpen()) ? 'composer' : 'workspace'
    this.host.show(dialog, placement)
    if (this.host.dialog() !== dialog) return undefined
    this.view = view
    return view
  }

  private close(view?: View, returnSettings = true): void {
    if (view === undefined || !this.active(view)) return
    this.view = undefined
    this.host.dismiss()
    if (returnSettings) this.host.returnToSettings()
  }

  /** One read per key + one trailing read after invalidation. No native scheduling. */
  private request(key: string, view: View | undefined, dirty: boolean, run: () => Promise<unknown>, apply: (value: unknown) => void): Promise<void> {
    const context = view?.context ?? this.host.capture(), generation = this.generation
    const current = this.requests.get(key)
    if (current !== undefined && current.view === view && current.generation === generation && this.host.isCurrent(current.context)) {
      if (dirty) current.dirty = true
      return current.promise
    }
    const request: Request = { view, context, generation, dirty: false, promise: Promise.resolve() }
    this.requests.set(key, request)
    const alive = (): boolean => !this.disposed && this.requests.get(key) === request && generation === this.generation &&
      this.host.isCurrent(context) && (view === undefined || this.active(view))
    const aliveAfterDelete = (): boolean => !this.disposed && generation === this.generation && this.host.isCurrent(context) &&
      (view === undefined || this.active(view))
    request.promise = (async () => {
      try {
        const value = await run()
        if (alive() && !request.dirty) apply(value)
      } catch (error) {
        if (alive() && !request.dirty) {
          const message = diagnostic(error, 'Native read failed.')
          if (view !== undefined) {
            if (view.dialog instanceof JobsDialog) {
              view.dialog.setLoading(false)
              if (key.startsWith('job-output:')) view.dialog.setOutputError(key.slice('job-output:'.length), message)
              else view.dialog.setSnapshot({ available: false, reason: 'native-failed' })
            }
            if (view.dialog instanceof NativeInspectionDialog) {
              view.dialog.setReads({ plugins: { available: false, reason: 'native-failed' }, tools: { available: false, reason: 'native-failed' }, capabilities: this.host.info()?.capabilities ?? [] })
              view.dialog.setLoading(false)
            }
            if (view.dialog instanceof SelectDialog) {
              if (view.kind === 'default-effort') view.dialog.setItems([])
              view.dialog.setLoading(false); view.dialog.setMessage(message, true)
            }
            if (view.dialog instanceof ModelPickerDialog) { view.dialog.setLoading(false); view.dialog.setError(message) }
            if (view.kind !== 'default-model' && view.kind !== 'default-effort') this.host.report(message, true)
          } else if (key === 'status:goal') this.host.goal(undefined)
          else if (key === 'status:working-directory') this.host.directory(undefined)
          else if (key === 'settings-summary') {
            this.defaults = { available: false, targets: [], limitation: message }
            this.host.render()
          }
        }
      } finally {
        if (this.requests.get(key) === request) {
          this.requests.delete(key)
          if (request.dirty && aliveAfterDelete()) void this.request(key, view, false, run, apply)
        }
      }
    })()
    return request.promise
  }

  private status(domain: 'goal' | 'working-directory', dirty = false): Promise<void> {
    const capability = domain === 'goal' ? 'native-goal' : 'native-working-directory'
    if (!this.host.info()?.capabilities.includes(capability)) return Promise.resolve()
    return this.request('status:' + domain, undefined, dirty,
      () => this.host.backend.command(domain === 'goal' ? 'native-goal' : 'native-working-directory'), value => {
        if (domain === 'goal') this.host.goal(readNativeGoal(value))
        else this.host.directory(readNativeDirectory(value))
        this.host.render()
      })
  }

  private refresh(view: View, dirty = false): void {
    if (view.kind === 'jobs') {
      void this.jobs(view, dirty)
      const dialog = view.dialog
      if (dialog instanceof JobsDialog && dialog.outputId !== undefined) void this.output(view, dialog.outputId, dirty)
    } else if (view.kind === 'inventory') void this.inventory(view, dirty)
    else if (view.kind === 'questions' || view.kind === 'answer') void this.questions(view, dirty)
    else if (view.kind === 'defaults' || view.kind === 'default-values') void this.defaultRead(view, dirty)
    else if (view.kind === 'default-model') void this.defaultModelRead(view, dirty)
    else if (view.kind === 'default-effort') void this.defaultEffortRead(view, dirty)
  }

  openJobs(): void {
    if (!this.host.info()?.capabilities.includes('native-jobs')) return
    let view: View | undefined
    const dialog = new JobsDialog(this.host.tui, {
      keymap: this.host.keymap, loading: true,
      onClose: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onRenderRequest: () => this.host.render(),
      onRefresh: () => { if (view !== undefined && this.active(view)) this.refresh(view, true) },
      onOpenOutput: job => { if (view !== undefined) void this.output(view, job.id) },
    })
    view = this.mount('jobs', dialog)
    if (view !== undefined) void this.jobs(view)
  }

  private jobs(view: View, dirty = false): Promise<void> {
    return this.request('jobs', view, dirty, () => this.host.backend.command('native-jobs'), value => {
      const snapshot = readNativeJobs(value)
      if (snapshot === undefined) throw new Error('DSH returned an invalid jobs view.')
      if (snapshot.available && snapshot.sessionId !== view.context.sessionId) throw new Error('DSH returned jobs for a different session.')
      if (view.dialog instanceof JobsDialog) { view.dialog.setSnapshot(snapshot); view.dialog.setLoading(false) }
      this.host.render()
    })
  }

  private output(view: View, jobId: string, dirty = false): Promise<void> {
    return this.request('job-output:' + jobId, view, dirty, () => this.host.backend.command('native-job-output', { jobId }), value => {
      const page = readNativeJobOutput(value)
      if (page === undefined) throw new Error('DSH returned an invalid job output page.')
      if (!(view.dialog instanceof JobsDialog) || view.dialog.outputId !== jobId) return
      if (!page.available) view.dialog.setOutputUnavailable(jobId, page.reason)
      else {
        if (page.sessionId !== view.context.sessionId || page.job.id !== jobId) throw new Error('DSH returned a different job output page.')
        view.dialog.setOutput(jobId, page)
      }
      this.host.render()
    })
  }

  openInventory(): void {
    const capabilities = this.host.info()?.capabilities ?? []
    if (!capabilities.includes('native-inventory') && !capabilities.includes('native-tools')) return
    let view: View | undefined
    const dialog = new NativeInspectionDialog(this.host.tui, {
      keymap: this.host.keymap, reads: { capabilities }, loading: true,
      onClose: () => this.close(view), onInterrupt: () => { void this.host.interrupt() }, onRenderRequest: () => this.host.render(),
    })
    view = this.mount('inventory', dialog)
    if (view !== undefined) void this.inventory(view)
  }

  private inventory(view: View, dirty = false): Promise<void> {
    return this.request('inventory', view, dirty, async () => {
      const capabilities = this.host.info()?.capabilities ?? []
      const values = await Promise.all([
        capabilities.includes('native-inventory') ? this.host.backend.command('native-inventory') : Promise.resolve({ available: false, reason: 'missing-service' }),
        capabilities.includes('native-tools') ? this.host.backend.command('native-tools') : Promise.resolve({ available: false, reason: 'missing-service' }),
      ])
      return values
    }, value => {
      if (!Array.isArray(value)) throw new Error('DSH returned an invalid capability view.')
      const plugins = readNativePlugins(value[0]), tools = readNativeTools(value[1])
      if (plugins === undefined || tools === undefined) throw new Error('DSH returned an invalid plugin/tool view.')
      if (tools.available && tools.sessionId !== view.context.sessionId) throw new Error('DSH returned tools for a different session.')
      if (view.dialog instanceof NativeInspectionDialog) {
        view.dialog.setReads({ plugins, tools, capabilities: this.host.info()?.capabilities ?? [] })
        view.dialog.setLoading(false)
      }
      this.host.render()
    })
  }

  openQuestions(): void {
    if (!this.host.info()?.capabilities.includes('continued-questions')) return
    let view: View | undefined
    const dialog = new SelectDialog(this.host.tui, {
      title: 'Native pending questions', loading: true, items: [], keymap: this.host.keymap,
      onCancel: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onSelect: value => {
        if (view === undefined || !this.active(view) || typeof value !== 'string') return
        void this.chooseQuestion(view, value)
      },
    })
    view = this.mount('questions', dialog)
    if (view !== undefined) void this.questions(view)
  }

  private questions(view: View, dirty = false): Promise<void> {
    return this.request('questions', view, dirty, () => this.host.backend.command('native-questions'), value => {
      const snapshot = readContinuedQuestions(value)
      if (snapshot === undefined || snapshot.sessionId !== view.context.sessionId ||
          (snapshot.attachmentId !== undefined && snapshot.attachmentId !== view.context.attachmentId)) throw new Error('DSH returned an invalid pending-question view.')
      if (view.kind === 'answer') {
        const row = snapshot.active.find(row => row.callId === view.row?.callId)
        if (snapshot.available && (row === undefined || !continuedQuestionAnswerable(row))) {
          this.close(view)
          this.host.report(row?.replyQueued ? 'The native reply is already queued.' : 'The native question is no longer waiting.')
        }
        return
      }
      if (view.dialog instanceof SelectDialog) {
        view.dialog.setItems(continuedQuestionChoices(snapshot.active), { preserveValue: true })
        view.dialog.setMessage(continuedQuestionsNote(snapshot), !snapshot.available)
      }
      this.host.render()
    })
  }

  private async chooseQuestion(view: View, callId: string): Promise<void> {
    try {
      const snapshot = readContinuedQuestions(await this.host.backend.command('native-questions'))
      if (!this.active(view)) return
      if (snapshot === undefined || snapshot.sessionId !== view.context.sessionId ||
          (snapshot.attachmentId !== undefined && snapshot.attachmentId !== view.context.attachmentId)) throw new Error('DSH returned an invalid pending-question view.')
      const row = snapshot.active.find(row => row.callId === callId)
      if (row === undefined || !continuedQuestionAnswerable(row)) { this.refresh(view, true); return }
      let answerView: View | undefined
      let dialog: DecisionDialog
      dialog = new DecisionDialog(this.host.tui, {
        request: { id: 'continued:' + callId, kind: 'question', title: 'Answer native continued question',
          questions: row.questions.map(q => ({ ...q, options: [...(q.options ?? [])] })) },
        keymap: this.host.keymap, onCancel: () => this.close(answerView), onInterrupt: () => { void this.host.interrupt() },
        onSubmit: value => { if (answerView !== undefined) void this.answerQuestion(answerView, callId, value) },
        ...(this.host.details === undefined ? {} : { onDetails: (content: DecisionDetailContent) => this.host.details?.(dialog, content) }),
      })
      answerView = this.mount('answer', dialog, view.context)
      if (answerView !== undefined) answerView.row = row
    } catch (error) {
      if (this.active(view)) {
        if (view.dialog instanceof SelectDialog) view.dialog.setMessage(diagnostic(error, 'Native question read failed.'), true)
        this.host.render()
      }
    }
  }

  private async answerQuestion(view: View, callId: string, answer: unknown): Promise<void> {
    if (!this.active(view)) return
    if (object(answer)?.cancelled === true) { this.close(view); return }
    this.close(view, false)
    try {
      const result = object(await this.host.backend.command('native-question-answer', { callId, answer }))
      if (!this.host.isCurrent(view.context)) return
      if (result?.outcome === 'accepted') this.host.report('Reply accepted by DSH; the native inbox owns delivery.')
      else if (result?.outcome === 'queued') this.host.report('The native reply is already queued.')
      else if (result?.outcome === 'unavailable' || result?.outcome === 'stale') this.host.report('The native question is no longer answerable.')
      else throw new Error('DSH returned an invalid late-answer result.')
    } catch (error) { if (this.host.isCurrent(view.context)) this.host.report(diagnostic(error, 'Native answer failed.'), true) }
    finally { if (this.host.isCurrent(view.context)) this.host.returnToSettings() }
  }

  private modelDefault(read: NativeDefaultSettingsRead | undefined): NativeDefaultSettingView | undefined {
    return read?.targets.find(field => field.target === 'agent-default-model')
  }

  openDefaultModel(): void {
    const capabilities = this.host.info()?.capabilities ?? []
    if (!capabilities.includes('native-defaults') || !capabilities.includes('models')) return
    const field = this.modelDefault(this.defaults)
    let view: View | undefined
    const dialog = new ModelPickerDialog(this.host.tui, {
      title: 'Choose default model', routeLabel: 'default', models: [], loading: true,
      currentProvider: field?.provider, currentModel: field?.model, keymap: this.host.keymap,
      onCancel: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onSelect: value => {
        if (view === undefined || !this.active(view)) return
        const field = this.modelDefault(view.defaults)
        if (field === undefined || !field.available || !field.writable || field.revision === undefined) return
        const context = view.context
        this.close(view, false)
        void this.writeDefault(context, 'agent-default-model', value, field.revision)
      },
    })
    view = this.mount('default-model', dialog)
    if (view !== undefined) void this.defaultModelRead(view)
  }

  private defaultModelRead(view: View, dirty = false): Promise<void> {
    if (view.dialog instanceof ModelPickerDialog) view.dialog.setLoading(true)
    return this.request('default-model', view, dirty, async () => await Promise.all([
      this.host.backend.command('native-defaults'), this.host.backend.command('models'),
    ]), value => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('DSH returned an invalid default model view.')
      const read = readNativeDefaults(value[0])
      if (read === undefined) throw new Error('DSH returned an invalid native defaults view.')
      this.defaults = read; view.defaults = read
      const field = this.modelDefault(read), dialog = view.dialog
      if (!(dialog instanceof ModelPickerDialog)) return
      if (field === undefined || !field.available || !field.writable || field.revision === undefined) {
        dialog.setModels([])
        dialog.setError(field?.limitation ?? read.limitation ?? 'The native default model is not writable in this composition.')
        this.host.render(); return
      }
      if (!Array.isArray(value[1])) throw new Error('DSH returned an invalid native model catalog.')
      const models: ModelPickerItem[] = value[1].flatMap(value => {
        const row = object(value)
        if (row === undefined || typeof row.id !== 'string' || !row.id || typeof row.provider !== 'string' || !row.provider || typeof row.model !== 'string' || !row.model) return []
        return [{ id: row.id, provider: row.provider, model: row.model,
          label: typeof row.label === 'string' && row.label ? row.label : row.model,
          ...(typeof row.description === 'string' ? { description: row.description } : {}) }]
      })
      // This is the persisted default tuple, never the live session route. The
      // picker marks it once via routeLabel, not an inferred isDefault flag.
      dialog.setCurrentRoute(field.provider, field.model)
      dialog.setModels(models)
      dialog.setError(models.length > 0 ? undefined : 'No native models are available in this composition.')
      dialog.setLoading(false)
      this.host.render()
    })
  }

  openDefaultEffort(): void {
    if (!this.host.info()?.capabilities.includes('native-defaults')) return
    let view: View | undefined
    const dialog = new SelectDialog(this.host.tui, {
      title: 'Default model effort', subtitle: 'Saved DSH default; levels belong to the default model.',
      loading: true, items: [], keymap: this.host.keymap,
      onCancel: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onSelect: value => {
        if (view === undefined || !this.active(view) || typeof value !== 'string') return
        const field = this.modelDefault(view.defaults)
        if (field === undefined || !field.available || !field.writable || field.revision === undefined ||
            typeof field.value !== 'string' || !field.value || field.reasoningAvailable !== true || field.reasoningSupported !== true ||
            (value !== '' && !field.reasoningEfforts?.some(level => level.id === value))) return
        const context = view.context
        this.close(view, false)
        void this.writeDefault(context, 'agent-default-model', field.value, field.revision, value === '' ? null : value)
      },
    })
    view = this.mount('default-effort', dialog)
    if (view !== undefined) void this.defaultEffortRead(view)
  }

  private defaultEffortRead(view: View, dirty = false): Promise<void> {
    if (view.dialog instanceof SelectDialog) view.dialog.setLoading(true)
    return this.request('default-effort', view, dirty, () => this.host.backend.command('native-defaults'), value => {
      const read = readNativeDefaults(value)
      if (read === undefined) throw new Error('DSH returned an invalid native defaults view.')
      this.defaults = read; view.defaults = read
      const field = this.modelDefault(read), dialog = view.dialog
      if (!(dialog instanceof SelectDialog)) return
      dialog.setMessage(undefined)
      const levels = field?.reasoningEfforts ?? []
      const limitation = field === undefined || !field.available || !field.writable || field.revision === undefined || typeof field.value !== 'string' || !field.value
        ? field?.limitation ?? read.limitation ?? 'The native default model is not writable in this composition.'
        : field.reasoningAvailable !== true ? 'Native reasoning metadata for the default model is unavailable.'
        : field.reasoningSupported !== true || levels.length === 0 ? 'The default model exposes no native reasoning levels.' : undefined
      if (limitation !== undefined || field === undefined) {
        dialog.setItems([]); dialog.setMessage(limitation, true); dialog.setLoading(false)
        this.host.render(); return
      }
      dialog.setItems([
        { value: '', label: 'Default' + (field.reasoningEffort === undefined ? ' · default' : ''),
          description: field.defaultReasoningEffort === undefined ? 'Use the native model/adapter default; remove the explicit override.'
            : 'Model default (' + field.defaultReasoningEffort + '); remove the explicit override.' },
        ...levels.map(level => ({ value: level.id,
          label: (level.label ?? level.id) + (level.id === field.reasoningEffort ? ' · default'
            : level.id === field.effectiveReasoningEffort ? ' · effective' : ''), description: level.description ?? level.id })),
      ], { preserveValue: true })
      dialog.setLoading(false)
      this.host.render()
    })
  }

  openDefaults(target?: DefaultSettingTarget): void {
    if (target === 'agent-default-model') { this.openDefaultModel(); return }
    if (!this.host.info()?.capabilities.includes('native-defaults')) return
    let view: View | undefined
    const dialog = new SelectDialog(this.host.tui, {
      title: target === undefined ? 'Native defaults' : target === 'agent-preset-default' ? 'Default agent preset' : 'Default permission preset',
      loading: true, items: [], keymap: this.host.keymap,
      onCancel: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onSelect: value => {
        if (view === undefined || !this.active(view) || typeof value !== 'string') return
        if (view.target === undefined) {
          if (value === 'agent-preset-default' || value === 'permission-default-preset' || value === 'agent-default-model') this.openDefaults(value)
        } else {
          const field = view.defaults?.targets.find(field => field.target === view?.target)
          if (field !== undefined) this.confirmDefault(view, field, value)
        }
      },
    })
    view = this.mount(target === undefined ? 'defaults' : 'default-values', dialog)
    if (view !== undefined) { view.target = target; void this.defaultRead(view) }
  }

  refreshSettings(): void {
    if (!this.host.info()?.capabilities.includes('native-defaults')) return
    void this.request('settings-summary', undefined, true, () => this.host.backend.command('native-defaults'), value => {
      const read = readNativeDefaults(value)
      if (read === undefined) throw new Error('DSH returned an invalid native defaults view.')
      this.defaults = read; this.host.render()
    })
  }

  private defaultRead(view: View, dirty = false): Promise<void> {
    return this.request('defaults', view, dirty, () => this.host.backend.command('native-defaults'), value => {
      const read = readNativeDefaults(value)
      if (read === undefined) throw new Error('DSH returned an invalid native defaults view.')
      this.defaults = read; view.defaults = read
      if (!(view.dialog instanceof SelectDialog)) return
      view.dialog.setMessage(undefined)
      if (view.target === undefined) {
        view.dialog.setItems(read.targets.map(field => ({ value: field.target,
          label: (field.target === 'agent-preset-default' ? 'Agent preset' : field.target === 'agent-default-model' ? 'Model' : 'Permission preset') + ' · ' + (field.effectiveValue ?? field.value ?? 'Unavailable'),
          description: field.limitation ?? (field.writable ? 'Native revision-guarded default' : 'Read-only') })), { preserveValue: true })
      } else {
        const field = read.targets.find(field => field.target === view.target)
        if (field === undefined || !field.writable || field.revision === undefined) {
          view.dialog.setItems([])
          view.dialog.setMessage(field?.limitation ?? 'This native default is not writable in the current composition.', true)
          this.host.render(); return
        }
        view.dialog.setItems(field.options.map(option => ({ value: option.id,
          label: (option.label ?? option.id) + (option.id === (field.effectiveValue ?? field.value) ? ' · default' : ''), description: option.description ?? option.id })), { preserveValue: true })
      }
      this.host.render()
    })
  }

  private confirmDefault(view: View, field: NativeDefaultSettingView, value: string): void {
    if (!this.active(view) || !field.writable || field.revision === undefined || !field.options.some(option => option.id === value)) return
    const context = view.context, revision = field.revision
    let confirmation: View | undefined
    const dialog = new DecisionDialog(this.host.tui, {
      request: { id: 'native-default:' + field.target, kind: 'approval', title: 'Change native default?',
        message: `${field.target === 'agent-preset-default' ? 'Agent preset' : 'Permission preset'}: ${field.effectiveValue ?? field.value ?? 'unset'} → ${value}\nThis edits the native default, not the current session selection. Native revision ${revision}.`,
        options: [{ label: 'Cancel', value: false }, { label: 'Apply native default', value: true }] },
      keymap: this.host.keymap, onCancel: () => this.close(confirmation), onInterrupt: () => { void this.host.interrupt() },
      onSubmit: answer => {
        if (confirmation === undefined || !this.active(confirmation)) return
        if (answer !== true) { this.close(confirmation); return }
        this.close(confirmation, false)
        void this.writeDefault(context, field.target, value, revision)
      },
    })
    confirmation = this.mount('confirm-default', dialog, context)
  }

  private async writeDefault(context: NativeViewContext, target: DefaultSettingTarget, value: string, expectedRevision: number, reasoningEffort?: string | null): Promise<void> {
    const modelDefault = target === 'agent-default-model'
    const feedback = (message: string, error = false): void => {
      if (!modelDefault || this.host.settingsMessage?.(message, error) !== true) this.host.report(message, error)
    }
    // A summary started before this explicit write must not later restore an
    // obsolete default. Existing native notifications provide the same fence.
    const summary = this.requests.get('settings-summary')
    if (summary !== undefined) summary.dirty = true
    try {
      const result = object(await this.host.backend.command('native-default-update', {
        target, value, expectedRevision, attachmentId: context.attachmentId,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }))
      if (!this.host.isCurrent(context)) return
      let message: string, error: boolean
      if (result?.ok === true) {
        const unchanged = result.unchanged === true
        error = result.changed !== true && !unchanged
        message = unchanged ? 'The native default already has this selection.'
          : error ? 'DSH accepted the write, but the read-back value is not confirmed.'
          : modelDefault ? (reasoningEffort === undefined ? 'Default model saved through DSH.' : 'Default model effort saved through DSH.')
          : 'Native default updated through DSH.'
      } else if (result?.ok === false) {
        error = true
        message = typeof result.message === 'string' ? result.message : 'Native default was not changed: ' + String(result.reason)
      } else throw new Error('DSH returned an invalid native default result.')
      this.defaults = undefined
      if (modelDefault) {
        // Refresh before restoring the Settings frame, using native read-back
        // rather than projecting the requested value as a persistence fact.
        try {
          const read = readNativeDefaults(await this.host.backend.command('native-defaults'))
          if (!this.host.isCurrent(context)) return
          if (read === undefined) throw new Error('DSH returned an invalid native defaults view.')
          this.defaults = read
        } catch (readError) {
          if (!this.host.isCurrent(context)) return
          const limitation = diagnostic(readError, 'Could not refresh native defaults.')
          this.defaults = { available: false, targets: [], limitation }
          message += ' Native state could not be refreshed; reopen Settings to retry.'
        }
      }
      feedback(message, error)
    } catch (error) {
      if (this.host.isCurrent(context)) {
        this.defaults = undefined
        // A local cancel is not a failed native write. The surface still returns
        // to Settings; only real failures become a red result line.
        if (asBackendError(error).code !== 'ABORTED') feedback(diagnostic(error, 'Native default update failed.'), true)
      }
    } finally { if (this.host.isCurrent(context)) this.host.returnToSettings() }
  }

  /** A literal /rename title is already an explicit user mutation. */
  renameTo(title: string): void {
    if (!this.host.info()?.capabilities.includes('session-rename') || title.trim() === '') return
    void this.rename(this.host.capture(), title)
  }

  openRename(): void {
    if (!this.host.info()?.capabilities.includes('session-rename')) return
    const context = this.host.capture()
    let view: View | undefined
    const current = this.host.info()?.title
    const dialog = new DecisionDialog(this.host.tui, {
      request: { id: 'native-rename', kind: 'question', title: 'Rename native session',
        message: 'Explicit rename pins the native user title; automatic generation remains DSH-owned.',
        questions: [{ id: 'title', question: current ? 'New title (current: ' + oneLine(sanitize(current), 80) + ')' : 'New session title', options: [] }] },
      keymap: this.host.keymap, onCancel: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onSubmit: answer => {
        if (view === undefined || !this.active(view)) return
        const result = object(answer), answers = result?.answers
        if (result?.cancelled === true) { this.close(view); return }
        const title = Array.isArray(answers) && typeof answers[0] === 'string' ? answers[0] : undefined
        if (title === undefined || title.trim() === '') return
        this.close(view, false)
        void this.rename(context, title)
      },
    })
    view = this.mount('rename', dialog, context)
  }

  private async rename(context: NativeViewContext, title: string): Promise<void> {
    try {
      const result = object(await this.host.backend.command('session-rename', { sessionId: context.sessionId, attachmentId: context.attachmentId, title }))
      if (!this.host.isCurrent(context)) return
      if (result?.ok === true && typeof result.title === 'string' && typeof result.sessionId === 'string' && result.stillCurrent !== false) {
        this.host.renamed(result.sessionId, result.title)
        this.host.report('Native session renamed.')
      } else this.host.report(typeof result?.message === 'string' ? result.message : 'The native session could not be renamed.', true)
    } catch (error) { if (this.host.isCurrent(context)) this.host.report(diagnostic(error, 'Native rename failed.'), true) }
    finally { if (this.host.isCurrent(context)) this.host.returnToSettings() }
  }

  openFork(): void {
    if (!this.host.info()?.capabilities.includes('session-fork')) return
    const context = this.host.capture()
    let view: View | undefined
    const dialog = new DecisionDialog(this.host.tui, {
      request: { id: 'native-fork', kind: 'approval', title: 'Fork native session?',
        message: 'Create a native root session from the current durable boundary and switch into it. The original DSH log stays intact; queued inputs are not copied.',
        options: [{ label: 'Cancel', value: false }, { label: 'Fork and switch', value: true }] },
      keymap: this.host.keymap, onCancel: () => this.close(view), onInterrupt: () => { void this.host.interrupt() },
      onSubmit: answer => {
        if (view === undefined || !this.active(view)) return
        if (answer !== true) { this.close(view); return }
        this.close(view, false)
        if (this.host.isCurrent(context)) void this.host.sessionCommand('session-fork', { sessionId: context.sessionId, attachmentId: context.attachmentId })
      },
    })
    view = this.mount('fork', dialog, context)
  }
}
