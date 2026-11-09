import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshBackend, type DshHostContext } from '../src/backend/context.ts'
import type { BackendEvent } from '../src/backend/types.ts'

function fixture(explicit = false) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  let selection: { provider: string; model: string; reasoningEffort?: string } | undefined = { provider: 'native', model: 'first' }
  let reads = 0
  const services = new Map<string, unknown>([
    ['agentDefaultModel', { currentSelection: () => selection }],
    ['llm', { listProviders: () => [{ id: 'native' }], listModels: async () => { reads++; return [{ id: 'first' }, { id: 'second' }] } }],
    ['agentPresets', { list: async () => { reads++; return [{ id: 'standard' }, { id: 'minimal' }] }, resolve: async () => ({ id: 'standard' }) }],
  ])
  const host: DshHostContext = {
    get: name => services.get(name),
    on: (name, listener) => {
      assert.equal(typeof listener, 'function')
      const fn = listener as (...args: unknown[]) => void
      const set = handlers.get(name) ?? new Set<(...args: unknown[]) => void>()
      set.add(fn); handlers.set(name, set)
      return () => { set.delete(fn) }
    },
  }
  const backend = createDshBackend(host, { cwd: '/fixture-not-opened',
    ...(explicit ? { provider: 'native', model: 'first' } : {}) })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { backend, events, reads: () => reads,
    setSelection: (next: typeof selection) => { selection = next },
    emit(name: string, ...args: unknown[]) { for (const listener of handlers.get(name) ?? []) listener(...args) },
  }
}

const invalidations = (events: BackendEvent[]): BackendEvent[] => events.filter(event =>
  event.type === 'presets_changed' || event.type === 'models_changed' || event.type === 'model_route')

test('settled native config and document notifications coalesce current metadata without querying catalogs', async () => {
  const f = fixture()
  try {
    const info = await f.backend.connect()
    const start = f.events.length, reads = f.reads()
    f.setSelection({ provider: 'native', model: 'second', reasoningEffort: 'high' })
    f.emit('app-boot/config-reload')
    f.emit('settings/document-updated', 'dsh-tui-preset-registry', 2)
    f.emit('settings/document-updated', 'custom-native-entry', 3)
    await Promise.resolve()
    const result = invalidations(f.events.slice(start))
    assert.deepEqual(result.map(event => event.type), ['model_route', 'presets_changed', 'models_changed'])
    for (const event of result) {
      assert.ok('sessionId' in event)
      assert.equal(event.sessionId, info.sessionId)
      assert.ok('attachmentId' in event)
      assert.equal(event.attachmentId, info.attachmentId)
    }
    const route = result[0]
    assert.ok(route?.type === 'model_route')
    assert.equal(route.model, 'second')
    assert.equal(route.reasoningEffort, 'high')
    assert.equal(f.reads(), reads, 'an invalidation neither reads a roster nor materializes an Agent')
    f.emit('app-boot/config-reload')
    await Promise.resolve()
    assert.equal(f.events.slice(start).filter(event => event.type === 'model_route').length, 1, 'same getter result is not announced twice')
  } finally { await f.backend.close() }
})

test('native pre/post configuration signals may update implicit defaults, but never replace an explicit pin', async () => {
  for (const explicit of [false, true]) {
    const f = fixture(explicit)
    try {
      await f.backend.connect()
      const start = f.events.length
      f.emit('app-boot/config-reload')
      await Promise.resolve()
      f.setSelection({ provider: 'native', model: 'second' })
      f.emit('app-boot/config-reload')
      await Promise.resolve()
      const routes = f.events.slice(start).filter(event => event.type === 'model_route')
      assert.equal(routes.length, explicit ? 0 : 1)
      assert.equal((await f.backend.command('state') as { model?: string }).model, explicit ? 'first' : 'second')
      f.setSelection(undefined)
      f.emit('app-boot/config-reload')
      await Promise.resolve()
      const last = f.events.filter(event => event.type === 'model_route').at(-1)
      if (!explicit) {
        assert.ok(last?.type === 'model_route')
        assert.equal(last.provider, '')
        assert.equal(last.model, '', 'unknown native default does not reuse stale route metadata')
      }
    } finally { await f.backend.close() }
  }
})

test('pre-commit HMR signals are not treated as catalog changes, and queued work ends with the attachment', async () => {
  const f = fixture()
  const info = await f.backend.connect()
  const start = f.events.length
  f.emit('hmr/change', 'file:///synthetic/preset.js')
  f.emit('hmr/reload', ['synthetic module'])
  await Promise.resolve()
  assert.deepEqual(invalidations(f.events.slice(start)), [])
  const next = await f.backend.command('new') as { sessionId: string; attachmentId: string }
  assert.notEqual(next.sessionId, info.sessionId)
  const current = f.events.length
  f.emit('settings/document-updated', 'another-native-entry', 1)
  await Promise.resolve()
  assert.ok(invalidations(f.events.slice(current)).every(event => 'sessionId' in event && event.sessionId === next.sessionId))
  const beforeClose = f.events.length
  f.emit('app-boot/config-reload')
  const close = f.backend.close()
  await close
  assert.deepEqual(invalidations(f.events.slice(beforeClose)), [], 'a pending microtask cannot announce metadata after close')
})
