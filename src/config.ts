import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { CcKeymapConfig } from './input/index.ts'

export interface Settings {
  screen: 'inline' | 'fullscreen'
  expandTools: boolean
  /** Group adjacent non-diff tool calls in the transcript. */
  groupTools: boolean
  expandedInputMaxLines: number
  expandedOutputMaxLines: number
  /** 0 follows terminal width; otherwise limits compact tool labels. */
  toolLabelClip: number
  diffViewMode: 'auto' | 'split' | 'unified'
  diffIndicatorMode: 'bars' | 'classic' | 'none'
  diffSplitMinWidth: number
  editDiffCollapsedLines: number
  writeDiffCollapsedLines: number
  diffWordWrap: boolean
  showThinking: boolean
  /** Collapsed thinking preview line count; 0 shows the summary line only. */
  thinkingPreviewLines: number
  /** Live thinking-duration timer interval in ms; 0 disables the timer. */
  thinkingLiveTimerMs: number
  /**
   * Local preference for native DSH session titles. `inherit` leaves the
   * native profile default untouched; the effective value is owned by DSH.
   */
  autoTitle: boolean | 'inherit'
}

export const defaults: Settings = {
  screen: 'fullscreen', expandTools: false, groupTools: true,
  expandedInputMaxLines: 5, expandedOutputMaxLines: 10, toolLabelClip: 0,
  diffViewMode: 'auto', diffIndicatorMode: 'bars', diffSplitMinWidth: 120,
  editDiffCollapsedLines: 24, writeDiffCollapsedLines: 0, diffWordWrap: true,
  showThinking: false, thinkingPreviewLines: 3, thinkingLiveTimerMs: 250,
  autoTitle: 'inherit',
}

/** One flat preference roster, shared by App, the Tools tab and render options. */
export const TOOL_SETTING_KEYS = [
  'groupTools', 'expandTools', 'expandedInputMaxLines', 'expandedOutputMaxLines',
  'toolLabelClip', 'diffViewMode', 'diffIndicatorMode', 'diffSplitMinWidth',
  'editDiffCollapsedLines', 'writeDiffCollapsedLines', 'diffWordWrap',
] as const satisfies readonly (keyof Settings)[]
export const EXPANDED_INPUT_MAX_LINES_VALUES = [5, 10, 20, 40, 80] as const
export const EXPANDED_OUTPUT_MAX_LINES_VALUES = [10, 20, 40, 80, 120] as const
export const TOOL_LABEL_CLIP_VALUES = [0, 40, 60, 80, 100, 120, 160] as const
export const DIFF_VIEW_MODE_VALUES = ['auto', 'split', 'unified'] as const
export const DIFF_INDICATOR_MODE_VALUES = ['bars', 'classic', 'none'] as const
export const DIFF_SPLIT_MIN_WIDTH_VALUES = [80, 100, 120, 140, 160, 180] as const
export const EDIT_DIFF_COLLAPSED_LINES_VALUES = [0, 12, 24, 36, 48, 80, 120] as const
export const WRITE_DIFF_COLLAPSED_LINES_VALUES = [0, 4, 8, 12, 24, 36] as const

/** Allowed collapsed-preview line counts (CC-style small roster). */
export const THINKING_PREVIEW_LINES_VALUES = [0, 1, 3, 5, 10] as const
/** Allowed live thinking-timer intervals; 0 disables the live timer. */
export const THINKING_LIVE_TIMER_MS_VALUES = [0, 90, 250, 500] as const

/** Validate both disk input and queued partial updates before any write. */
function parseSettings(data: Record<string, unknown> = {}): Settings {
  if (data.screen !== undefined && data.screen !== 'inline' && data.screen !== 'fullscreen') throw new Error('screen must be inline or fullscreen')
  for (const key of ['expandTools', 'groupTools', 'diffWordWrap', 'showThinking'] as const) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  }
  if (data.thinkingPreviewLines !== undefined && !THINKING_PREVIEW_LINES_VALUES.includes(data.thinkingPreviewLines as never)) throw new Error(`thinkingPreviewLines must be one of ${THINKING_PREVIEW_LINES_VALUES.join(', ')}`)
  if (data.thinkingLiveTimerMs !== undefined && !THINKING_LIVE_TIMER_MS_VALUES.includes(data.thinkingLiveTimerMs as never)) throw new Error(`thinkingLiveTimerMs must be one of ${THINKING_LIVE_TIMER_MS_VALUES.join(', ')}`)
  if (data.autoTitle !== undefined && data.autoTitle !== 'inherit' && typeof data.autoTitle !== 'boolean') throw new Error("autoTitle must be boolean or 'inherit'")
  if (data.diffViewMode !== undefined && !DIFF_VIEW_MODE_VALUES.includes(data.diffViewMode as never)) throw new Error(`diffViewMode must be one of ${DIFF_VIEW_MODE_VALUES.join(', ')}`)
  if (data.diffIndicatorMode !== undefined && !DIFF_INDICATOR_MODE_VALUES.includes(data.diffIndicatorMode as never)) throw new Error(`diffIndicatorMode must be one of ${DIFF_INDICATOR_MODE_VALUES.join(', ')}`)
  const ranges = {
    expandedInputMaxLines: [1, 5_000], expandedOutputMaxLines: [1, 5_000],
    toolLabelClip: [8, 500], diffSplitMinWidth: [40, 300],
    editDiffCollapsedLines: [0, 500], writeDiffCollapsedLines: [0, 500],
  } as const
  for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
    const value = data[key]
    if (value === undefined || (key === 'toolLabelClip' && value === 0)) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${key} must be an integer from ${minimum} to ${maximum}${key === 'toolLabelClip' ? ', or 0' : ''}`)
    }
  }
  return {
    screen: data.screen as Settings['screen'] | undefined ?? defaults.screen,
    expandTools: data.expandTools as boolean | undefined ?? defaults.expandTools,
    groupTools: data.groupTools as boolean | undefined ?? defaults.groupTools,
    expandedInputMaxLines: data.expandedInputMaxLines as number | undefined ?? defaults.expandedInputMaxLines,
    expandedOutputMaxLines: data.expandedOutputMaxLines as number | undefined ?? defaults.expandedOutputMaxLines,
    toolLabelClip: data.toolLabelClip as number | undefined ?? defaults.toolLabelClip,
    diffViewMode: data.diffViewMode as Settings['diffViewMode'] | undefined ?? defaults.diffViewMode,
    diffIndicatorMode: data.diffIndicatorMode as Settings['diffIndicatorMode'] | undefined ?? defaults.diffIndicatorMode,
    diffSplitMinWidth: data.diffSplitMinWidth as number | undefined ?? defaults.diffSplitMinWidth,
    editDiffCollapsedLines: data.editDiffCollapsedLines as number | undefined ?? defaults.editDiffCollapsedLines,
    writeDiffCollapsedLines: data.writeDiffCollapsedLines as number | undefined ?? defaults.writeDiffCollapsedLines,
    diffWordWrap: data.diffWordWrap as boolean | undefined ?? defaults.diffWordWrap,
    showThinking: data.showThinking as boolean | undefined ?? defaults.showThinking,
    thinkingPreviewLines: data.thinkingPreviewLines as number | undefined ?? defaults.thinkingPreviewLines,
    thinkingLiveTimerMs: data.thinkingLiveTimerMs as number | undefined ?? defaults.thinkingLiveTimerMs,
    autoTitle: data.autoTitle as Settings['autoTitle'] | undefined ?? defaults.autoTitle,
  }
}

/** UI preferences and recall live in ~/.dsh-tui unless explicitly overridden. */
export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_TUI_CONFIG_DIR ?? join(homedir(), '.dsh-tui')
}

function readObject(path: string): Record<string, unknown> | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object')
  return value as Record<string, unknown>
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

/**
 * Small cross-process guard for the recall file. The file is append-only UI
 * history, not a durable DSH store, so a lock file plus read-modify-write is
 * the smallest serialization that avoids overwriting another process/cwd.
 */
async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lock = path + '.lock'
  const deadline = Date.now() + 5_000
  let handle: Awaited<ReturnType<typeof open>> | undefined
  while (handle === undefined) {
    try {
      handle = await open(lock, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A crashed writer must not block recall forever. No credential or DSH
      // session fact is involved; the stale lock only delays prompt recall.
      try {
        const info = await stat(lock)
        if (Date.now() - info.mtimeMs > 30_000) { await unlink(lock).catch(() => {}); continue }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the prompt-history lock: ' + lock)
      await delay(10)
    }
  }
  try { return await run() }
  finally { await handle.close().catch(() => {}); await unlink(lock).catch(() => {}) }
}

/** The same small override map used by the editor, not a second configuration format. */
export class KeybindingsStore {
  readonly path: string
  private writes: Promise<void> = Promise.resolve()

  constructor(directory = configDirectory()) { this.path = join(directory, 'keybindings.json') }

  read(): CcKeymapConfig {
    const data = readObject(this.path) ?? {}
    for (const [id, value] of Object.entries(data)) {
      if (value !== null && typeof value !== 'string' && !(Array.isArray(value) && value.every(key => typeof key === 'string'))) {
        throw new Error('Invalid keybindings value for ' + id)
      }
    }
    return data as CcKeymapConfig
  }

  set(actionId: string, bindings: string[] | null | undefined, validate: (next: CcKeymapConfig, previous: CcKeymapConfig) => void): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      // Re-read at write time, preserving unrelated overrides and refusing to
      // overwrite malformed files. Concurrent edits in this app stay ordered.
      const previous = this.read(), next = { ...previous }
      if (bindings === undefined) delete next[actionId]
      else next[actionId] = bindings
      validate(next, previous)
      await atomicJson(this.path, next)
    })
    this.writes = write
    return write
  }

  flush(): Promise<void> { return this.writes }
}

export class SettingsStore {
  readonly path: string
  readonly warnings: string[] = []
  private invalid = false
  private value: Settings = { ...defaults }
  private writes: Promise<void> = Promise.resolve()

  constructor(directory = configDirectory()) {
    this.path = join(directory, 'settings.json')
    this.reload()
  }

  get(): Settings { return { ...this.value } }

  /**
   * Re-read the file without losing the last valid settings on a bad edit.
   * Unknown keys are warnings; parse/schema errors leave the old value live
   * and make subsequent writes refuse to overwrite the broken document.
   */
  reload(): string[] {
    const warnings: string[] = []
    try {
      const data = readObject(this.path)
      if (data !== undefined) {
        for (const key of Object.keys(data)) {
          if (!Object.hasOwn(defaults, key)) warnings.push('Unknown setting: ' + key)
        }
      }
      this.value = parseSettings(data)
      this.invalid = false
    } catch (error) {
      this.invalid = true
      warnings.push('Settings not applied: ' + String(error instanceof Error ? error.message : error))
    }
    this.warnings.length = 0
    this.warnings.push(...warnings)
    return [...warnings]
  }

  /**
   * Queue one read-modify-write. The disk file is re-read and validated at the
   * moment the write runs, so an external broken edit is never overwritten and
   * the in-memory value only changes after a successful save.
   */
  async set(patch: Partial<Settings>): Promise<void> {
    const write = this.writes.catch(() => {}).then(async () => {
      this.reload()
      if (this.invalid) throw new Error('Refusing to overwrite invalid settings file: ' + this.path)
      const next = parseSettings({ ...this.value, ...patch })
      await atomicJson(this.path, next)
      this.value = next
    })
    this.writes = write
    return write
  }

  flush(): Promise<void> { return this.writes }
}

type RecallMap = Record<string, string[]>

function normalizeRecallMap(value: Record<string, unknown>): RecallMap {
  const result: RecallMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || !entry.every(item => typeof item === 'string')) throw new Error('history values must be string arrays')
    result[key] = entry.slice(-500)
  }
  return result
}

/**
 * One recall file per config directory, shared by every cwd view. Writes are
 * serialized through a lock and re-read the disk so switching A→B→A or another
 * process writing a different cwd cannot silently drop entries. This is editor
 * recall only; DSH session persistence remains the durable conversation fact.
 */
export class PromptHistoryStore {
  readonly path: string
  readonly warnings: string[] = []
  private data: RecallMap = {}
  private readonly dirty = new Set<string>()
  private writes: Promise<void> = Promise.resolve()

  constructor(directory = configDirectory()) {
    this.path = join(directory, 'history.json')
    this.reload()
  }

  /**
   * Validate/read the latest disk snapshot. Malformed content keeps the last
   * usable in-memory data; unflushed additions for a cwd survive a valid read
   * until their queued disk-authoritative write lands.
   */
  reload(): string[] {
    const warnings: string[] = []
    try {
      const raw = readObject(this.path)
      const disk = raw === undefined ? {} : normalizeRecallMap(raw)
      for (const key of this.dirty) {
        const local = this.data[key] ?? []
        const target = disk[key] ?? []
        for (const item of local) if (!target.includes(item)) target.push(item)
        disk[key] = target.slice(-500)
      }
      this.data = disk
    } catch (error) {
      warnings.push('History not applied: ' + String(error instanceof Error ? error.message : error))
    }
    this.warnings.length = 0
    this.warnings.push(...warnings)
    return [...warnings]
  }

  entries(cwd: string): string[] { return [...(this.data[resolve(cwd)] ?? [])] }

  flush(): Promise<void> { return this.writes }

  add(cwd: string, text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve()
    const key = resolve(cwd)
    const write = this.writes.catch(() => {}).then(() => this.write(key, text))
    this.writes = write
    return write
  }

  private async write(cwd: string, text: string): Promise<void> {
    // Keep the last usable in-memory entries even when the save fails, so the
    // current session still has recall; the file itself must stay untouched.
    const local = this.data[cwd] ?? []
    if (local.at(-1) !== text) local.push(text)
    this.data[cwd] = local.slice(-500)
    this.dirty.add(cwd)
    await withFileLock(this.path, async () => {
      // Disk is authoritative; only the target cwd is updated, in serialized
      // order. Other cwds/processes are written back exactly as read.
      const raw = readObject(this.path)
      const disk: RecallMap = raw === undefined ? {} : normalizeRecallMap(raw)
      const target = disk[cwd] ?? []
      if (target.at(-1) !== text) target.push(text)
      disk[cwd] = target.slice(-500)
      await atomicJson(this.path, disk)
      this.data = disk
      this.dirty.delete(cwd)
    })
  }
}

const promptStores = new Map<string, PromptHistoryStore>()

function sharedPromptStore(directory: string): PromptHistoryStore {
  const key = resolve(directory)
  let store = promptStores.get(key)
  if (!store) { store = new PromptHistoryStore(key); promptStores.set(key, store) }
  return store
}

/** Editor recall view for one cwd; the shared store owns file serialization. */
export class PromptHistory {
  readonly path: string
  readonly warnings: string[]
  private readonly cwd: string
  private readonly store: PromptHistoryStore

  constructor(cwd: string, directory = configDirectory()) {
    this.cwd = resolve(cwd)
    this.store = sharedPromptStore(directory)
    this.path = this.store.path
    // A new view validates the current file (repair or external malformed edit)
    // without dropping additions still queued for this shared store.
    this.store.reload()
    this.warnings = this.store.warnings
  }

  entries(): string[] { return this.store.entries(this.cwd) }

  /** Wait for this UI recall file, never for DSH session persistence. */
  flush(): Promise<void> { return this.store.flush() }

  async add(text: string): Promise<void> { return this.store.add(this.cwd, text) }
}