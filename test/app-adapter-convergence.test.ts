import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { VirtualTerminal } from './helpers/terminal.ts'

class PresetReadBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly selected: string[] = []
  readonly info: SessionInfo
  locked = false
  readonly blank: boolean | undefined
  constructor(cwd: string, blank: boolean | undefined) {
    this.blank = blank
    this.info = { sessionId: 'convergence-root', attachmentId: 'convergence-attachment', cwd,
      provider: 'fixture', model: 'fixture', preset: 'standard', events: [], capabilities: ['commands', 'state', 'presets'] }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async connect(): Promise<SessionInfo> { return this.info }
  async send(): Promise<void> { throw new Error('No model prompt is allowed') }
  async respond(): Promise<void> { throw new Error('No question/permission response is allowed') }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queued: 0, queue: [], pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'presets') return { current: this.info.preset, ...(this.blank === undefined ? {} : { blank: this.blank }),
      presets: [{ id: 'standard', name: 'Standard' }, { id: 'minimal', name: 'Minimal' }] }
    if (name === 'preset') {
      assert.equal(typeof args.id, 'string')
      this.selected.push(args.id as string)
      if (this.locked) return { id: args.id, current: this.info.preset, locked: true }
      this.info.preset = args.id as string
      return this.info
    }
    throw new Error('Unexpected adapter command: ' + name)
  }
}

async function fixture(blank: boolean | undefined, locked = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-convergence-ui-'))
  const terminal = new VirtualTerminal(100, 32)
  const backend = new PresetReadBackend(directory, blank)
  backend.locked = locked
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, registerSignals: false })
  await app.start()
  return { app, backend, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}

for (const blank of [undefined, true, false] as const) {
  test(`App preset selection delegates unknown reads instead of manufacturing a lock (blank=${blank})`, async () => {
    const f = await fixture(blank)
    try {
      await f.app.submit('/preset minimal')
      if (blank === false) {
        assert.deepEqual(f.backend.selected, [], 'confirmed non-blank stays staged until a new session')
        assert.equal(f.app.session?.preset, 'standard')
      } else {
        assert.deepEqual(f.backend.selected, ['minimal'], 'native selector decides an unknown or confirmed blank session')
        assert.equal(f.app.session?.preset, 'minimal')
      }
    } finally { await f.close() }
  })
}

test('App unknown blank state does not bypass a native locked refusal', async () => {
  const f = await fixture(undefined, true)
  try {
    await f.app.submit('/preset minimal')
    assert.deepEqual(f.backend.selected, ['minimal'])
    assert.equal(f.app.session?.preset, 'standard', 'the native rejection is authoritative')
    assert.equal((f.app as unknown as { nextPreset?: string }).nextPreset, 'minimal',
      'a real native lock may stage the intent, but never changes current session facts')
  } finally { await f.close() }
})
