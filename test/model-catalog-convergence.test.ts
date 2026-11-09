/** Parent-owned bounded native model enumeration checks; no profile, Agent or model call. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createDshBackend } from '../src/backend/context.ts'
import type { BackendEvent, JsonRecord } from '../src/backend/types.ts'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(providers: string[], listModels: (provider: string) => Promise<unknown[]>) {
  const events: BackendEvent[] = []
  const registry = { listProviders: () => providers.map(id => ({ id })), listModels }
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const backend = createDshBackend({ get: name => name === 'llm' ? registry
    : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p0', model: 'm0' }) } : undefined,
    on: (name, listener) => {
      assert.equal(typeof listener, 'function')
      const fn = listener as (...args: unknown[]) => void
      const set = listeners.get(name) ?? new Set<(...args: unknown[]) => void>()
      set.add(fn); listeners.set(name, set)
      return () => { set.delete(fn) }
    },
  }, { cwd: '/fixture-not-opened' })
  backend.onEvent(event => events.push(event))
  return { backend, events, emit(name: string, ...args: unknown[]) {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  } }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native catalog worker did not reach the expected state')
    await delay(2)
  }
}

function rows(value: unknown): JsonRecord[] {
  assert.ok(Array.isArray(value))
  return value.map(item => {
    assert.ok(item !== null && typeof item === 'object' && !Array.isArray(item))
    return item as JsonRecord
  })
}

test('native catalog reads run four at a time while output keeps native registry/model order', async () => {
  const providers = Array.from({ length: 8 }, (_, index) => 'p' + index)
  const gates = new Map(providers.map(provider => [provider, deferred<unknown[]>()]))
  const calls: string[] = []
  let active = 0, maxActive = 0
  const f = fixture(providers, provider => {
    calls.push(provider)
    active++; maxActive = Math.max(maxActive, active)
    return gates.get(provider)!.promise.finally(() => { active-- })
  })
  const listing = f.backend.command('models')
  try {
    await until(() => calls.length === 4)
    assert.deepEqual(calls, ['p0', 'p1', 'p2', 'p3'])
    assert.equal(active, 4)
    gates.get('p3')!.resolve([{ id: 'm3' }])
    await until(() => calls.length === 5)
    assert.equal(calls[4], 'p4')
    for (const provider of ['p2', 'p1', 'p0', 'p4']) gates.get(provider)!.resolve([{ id: 'm' + provider.slice(1) }])
    await until(() => calls.length === 8)
    for (const provider of ['p7', 'p6', 'p5']) gates.get(provider)!.resolve([{ id: 'm' + provider.slice(1) }])
    const result = rows(await listing)
    assert.deepEqual(result.map(row => row.provider), providers, 'completion order never becomes presentation order')
    assert.deepEqual(result.map(row => row.model), providers.map(provider => 'm' + provider.slice(1)))
    assert.equal(maxActive, 4)
    assert.equal(active, 0)
    assert.equal(result.filter(row => row.isDefault === true).length, 1)
    assert.equal(result.find(row => row.isDefault === true)?.provider, 'p0')
  } finally {
    for (const [provider, gate] of gates) gate.resolve([{ id: 'm' + provider.slice(1) }])
    await listing.catch(() => {})
    await f.backend.close()
  }
})

test('parallel native catalog failures are isolated, redacted and reported in provider order', async () => {
  const providers = ['p0', 'p1', 'p2', 'p3']
  const gates = new Map(providers.map(provider => [provider, deferred<unknown[]>()]))
  const calls: string[] = []
  const f = fixture(providers, provider => { calls.push(provider); return gates.get(provider)!.promise })
  const listing = f.backend.command('models')
  try {
    await until(() => calls.length === 4)
    // Synthetic credential-shaped text tests diagnostics only, never real secrets.
    gates.get('p3')!.reject(new Error('Unavailable; api_key=synthetic-catalog-key'))
    gates.get('p1')!.reject(new Error('First unavailable provider'))
    gates.get('p2')!.resolve([{ id: 'm2' }, { id: 'm2b' }])
    gates.get('p0')!.resolve([{ id: 'm0' }])
    const result = rows(await listing)
    assert.deepEqual(result.map(row => row.provider), ['p0', 'p2', 'p2'])
    const warning = f.events.find(event => event.type === 'warning')
    assert.ok(warning?.type === 'warning')
    assert.ok(warning.message.indexOf('p1:') < warning.message.indexOf('p3:'))
    assert.equal(warning.message.includes('synthetic-catalog-key'), false)
    assert.match(warning.message, /redacted/)
    assert.deepEqual(calls, providers, 'each native registry entry is queried exactly once')
  } finally {
    for (const [provider, gate] of gates) gate.resolve([{ id: 'm' + provider.slice(1) }])
    await listing.catch(() => {})
    await f.backend.close()
  }
})

test('native model registry events invalidate only the current surface without reading a catalog and dispose on close', async () => {
  let catalogCalls = 0
  const f = fixture(['p0'], async () => { catalogCalls++; return [{ id: 'm0' }] })
  try {
    const info = await f.backend.connect()
    const before = catalogCalls
    f.emit('llm/adapters-updated')
    f.emit('llm/models-updated', 'p0')
    const invalidations = f.events.filter(event => event.type === 'models_changed')
    assert.equal(invalidations.length, 2)
    for (const event of invalidations) {
      assert.ok(event.type === 'models_changed')
      assert.equal(event.sessionId, info.sessionId)
      assert.equal(event.attachmentId, info.attachmentId)
    }
    assert.equal(catalogCalls, before, 'metadata events do not fetch/import catalogs or create an Agent')
    await f.backend.close()
    f.emit('llm/models-updated', 'p0')
    assert.equal(f.events.filter(event => event.type === 'models_changed').length, 2)
  } finally { await f.backend.close() }
})

test('native catalog reads remain fresh, empty and all-failed catalogs retain explicit native failure semantics', async () => {
  let id = 'first', calls = 0
  const f = fixture(['p0'], async () => { calls++; return [{ id }] })
  try {
    assert.equal(rows(await f.backend.command('models'))[0]?.model, 'first')
    id = 'second'
    assert.equal(rows(await f.backend.command('models'))[0]?.model, 'second')
    assert.equal(calls, 2, 'no TUI provider/model cache was introduced')
  } finally { await f.backend.close() }
  for (const providers of [[], ['p0', 'p1']]) {
    const bad = fixture(providers, async () => { throw new Error('Synthetic native catalog failure') })
    try {
      await assert.rejects(bad.backend.command('models'), error => {
        assert.ok(error !== null && typeof error === 'object' && 'code' in error)
        return error.code === 'MODELS_UNAVAILABLE'
      })
    } finally { await bad.backend.close() }
  }
})
