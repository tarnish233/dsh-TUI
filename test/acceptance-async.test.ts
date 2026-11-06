import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { delay, VirtualTerminal } from './helpers/terminal.ts'

class DeferredRouteBackend implements Backend {
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  info: SessionInfo
  pending?: (result: unknown) => void
  constructor(cwd: string) {
    this.info = { sessionId: 'async-session', attachmentId: 'async-attachment', cwd, provider: 'old-provider', model: 'old-model', capabilities: ['model', 'effort', 'efforts'] }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send() {}
  async cancel() {}
  async respond() {}
  async close() {}
  async command(name: string, _args?: JsonRecord): Promise<unknown> {
    if (name === 'model' || name === 'effort' || name === 'models') return await new Promise(resolve => { this.pending = resolve })
    if (name === 'auto-title') return { available: false, enabled: false }
    return this.info
  }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  publishRoute(provider: string, model: string) {
    this.info = { ...this.info, provider, model }
    this.emit({ type: 'ready', info: this.info })
  }
}

// Parent-owned late-result acceptance: metadata can change routes without
// replacing an attachment, so attachment identity alone is not a safe guard.
for (const command of ['model', 'effort'] as const) {
  test(`parent async acceptance: a late ${command} result cannot restore an obsolete route in the same attachment`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-async-route-'))
    const backend = new DeferredRouteBackend(directory)
    const terminal = new VirtualTerminal()
    const app = new App({ backend, cwd: directory, configDir: directory, terminal, registerSignals: false })
    try {
      await app.start()
      const applying = app.submit(command === 'model' ? '/model old-provider/old-model' : '/effort low')
      assert.ok(backend.pending, 'the old request is actually in flight')
      backend.publishRoute('new-provider', 'new-model')
      backend.pending!({ provider: 'old-provider', model: 'old-model', reasoningEffort: 'low', effectiveEffort: 'low', defaultWarning: 'old request warning' })
      await applying
      assert.equal(app.session?.provider, 'new-provider')
      assert.equal(app.session?.model, 'new-model')
      assert.equal(app.store.items.some(item => item.kind === 'notice' && item.text.includes('old request warning')), false)
    } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
}

test('parent async acceptance: a late model catalog cannot replace a newer Settings surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-async-focus-'))
  const backend = new DeferredRouteBackend(directory)
  const terminal = new VirtualTerminal()
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, registerSignals: false })
  try {
    await app.start()
    const selecting = app.submit('/model')
    assert.ok(backend.pending)
    await app.submit('/settings')
    await delay(30); await terminal.flush()
    assert.match(terminal.screen(), /Settings/)
    backend.pending!([{ id: 'old-provider/old-model', provider: 'old-provider', model: 'old-model', label: 'Old catalog model' }])
    await selecting
    await delay(30); await terminal.flush()
    assert.match(terminal.screen(), /Settings/)
    assert.doesNotMatch(terminal.screen(), /Choose model/)
  } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
})
