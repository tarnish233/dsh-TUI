import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { CcKeymapConfig } from './input/index.ts'

export interface Settings {
  screen: 'inline' | 'fullscreen'
  expandTools: boolean
  showThinking: boolean
}

export const defaults: Settings = { screen: 'inline', expandTools: false, showThinking: false }

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_PI_TUI_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dsh-pi-tui')
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
          if (!['screen', 'expandTools', 'showThinking'].includes(key)) warnings.push('Unknown setting: ' + key)
        }
        if (data.screen !== undefined && data.screen !== 'inline' && data.screen !== 'fullscreen') throw new Error('screen must be inline or fullscreen')
        if (data.expandTools !== undefined && typeof data.expandTools !== 'boolean') throw new Error('expandTools must be boolean')
        if (data.showThinking !== undefined && typeof data.showThinking !== 'boolean') throw new Error('showThinking must be boolean')
      }
      this.value = {
        screen: data?.screen as Settings['screen'] | undefined ?? defaults.screen,
        expandTools: data?.expandTools as boolean | undefined ?? defaults.expandTools,
        showThinking: data?.showThinking as boolean | undefined ?? defaults.showThinking,
      }
      this.invalid = false
    } catch (error) {
      this.invalid = true
      warnings.push('Settings not applied: ' + String(error instanceof Error ? error.message : error))
    }
    this.warnings.length = 0
    this.warnings.push(...warnings)
    return [...warnings]
  }

  async set(patch: Partial<Settings>): Promise<void> {
    if (this.invalid) throw new Error('Refusing to overwrite invalid settings file: ' + this.path)
    this.value = { ...this.value, ...patch }
    const snapshot = { ...this.value }
    const write = this.writes.catch(() => {}).then(() => atomicJson(this.path, snapshot))
    this.writes = write
    return write
  }
}

/** Editor recall only; this file is never used to reconstruct DSH conversation facts. */
export class PromptHistory {
  readonly path: string
  readonly warnings: string[] = []
  private readonly cwd: string
  private readonly all: Record<string, string[]> = {}
  private invalid = false
  private writes: Promise<void> = Promise.resolve()

  constructor(cwd: string, directory = configDirectory()) {
    this.cwd = resolve(cwd)
    this.path = join(directory, 'history.json')
    try {
      const data = readObject(this.path)
      if (!data) return
      for (const [key, value] of Object.entries(data)) {
        if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('history values must be string arrays')
        this.all[key] = value.slice(-500) as string[]
      }
    } catch (error) {
      this.invalid = true
      this.warnings.push('History not applied: ' + String(error instanceof Error ? error.message : error))
    }
  }

  entries(): string[] { return [...(this.all[this.cwd] ?? [])] }

  /** Wait for this UI recall file, never for DSH session persistence. */
  flush(): Promise<void> { return this.writes }

  async add(text: string): Promise<void> {
    if (!text.trim()) return
    const entries = this.all[this.cwd] ?? []
    if (entries.at(-1) !== text) entries.push(text)
    this.all[this.cwd] = entries.slice(-500)
    if (this.invalid) return
    const snapshot = structuredClone(this.all)
    const write = this.writes.catch(() => {}).then(() => atomicJson(this.path, snapshot))
    this.writes = write
    return write
  }
}
