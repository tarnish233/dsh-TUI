/**
 * Focused regressions for the native default-model Settings target.
 *
 * Everything here is an offline fake: no profile, credential, session file,
 * model request, provider or subprocess is touched. The fakes model the public
 * DSH contracts the adapter actually uses (`settings.describe/mutate` with a
 * raw-config revision, `agentDefaultModel.currentSelection/saveSelection`, and
 * `llm.listProviders/listModels/resolveModelInfo`).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import { FakeDshHost, fakeNativeHelpers, nextTask } from '../src/backend/testing.ts'

// --------------------------------------------------------------- fixtures

interface FixtureEffort {
  id: string
  name?: string
  description?: string
}

interface FixtureModel {
  provider: string
  id: string
  reasoning?: { efforts: FixtureEffort[]; defaultEffort?: string }
}

interface FixtureSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface RecordedOp {
  op: string
  path: string[]
  value?: unknown
}

interface RecordedCall {
  ns: string
  ops: RecordedOp[]
  expectedRevision: number | undefined
}

interface Gate {
  promise: Promise<void>
  release(): void
}

function gate(): Gate {
  let release: () => void = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function deferred(): Gate {
  return gate()
}

/** The volatile settings form shape the installed `dsh-settings` emits. */
function volatileSchema(fields: readonly string[]): unknown {
  const dict: Record<string, number> = {}
  const refs: Record<string, unknown> = { 1: { type: 'object', meta: {}, dict } }
  let uid = 2
  for (const field of fields) {
    dict[field] = uid
    refs[String(uid)] = { type: 'string', meta: { volatile: true } }
    uid += 1
  }
  return { uid: 1, refs }
}

interface Fixture {
  readonly host: FakeDshHost
  backend: DshContextBackend
  readonly warnings: string[]
  readonly calls: RecordedCall[]
  readonly saves: FixtureSelection[]
  readonly resolveCalls: string[]
  state: { selection: FixtureSelection; revision: number }
  /** Overrides only the runtime owner's answer, leaving the descriptor untouched. */
  runtimeSelection: FixtureSelection | undefined
  models: FixtureModel[]
  loaderEntries: Array<{ options: { id: string; name: string } }>
  mutateError: unknown
  reasoningError: unknown
  /** Fail the metadata read for one exact native pair only. */
  reasoningErrorFor: { pair: string; error: unknown } | undefined
  /** Answer the metadata read for one exact pair with a malformed payload. */
  resolveInfoFor: { pair: string; payload: unknown } | undefined
  reasoningGate: Gate | undefined
  mutateGate: Gate | undefined
  /** Providers whose native `llm.listModels` rejects, so the catalog reports one isolated failure. */
  providerFailures: Map<string, Error>
  /** Every provider passed to `llm.listModels`, in call order (catalog-read proof). */
  modelReads: string[]
  /** Simulate a native read-back that does not match the requested selection. */
  readBackOverride: FixtureSelection | undefined
  describeCount: number
}

const MODEL_PACKAGE = '@deepseek-ai/dsh-agent-default-model'

function fixture(
  options: {
    selection?: FixtureSelection
    models?: FixtureModel[]
    extra?: (host: FakeDshHost) => void
    backend?: Partial<DshContextBackendOptions>
  } = {},
): Fixture {
  const host = new FakeDshHost()
  const warnings: string[] = []
  const calls: RecordedCall[] = []
  const saves: FixtureSelection[] = []
  const resolveCalls: string[] = []
  const state: Fixture['state'] = {
    selection: options.selection ?? { provider: 'p1', model: 'm1' },
    revision: 0,
  }
  const models: FixtureModel[] = options.models ?? [
    {
      provider: 'p1',
      id: 'm1',
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    },
    { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } },
    { provider: 'p1', id: 'm3', reasoning: { efforts: [{ id: 'low' }] } },
  ]
  const fixtureValue: Fixture = {
    host,
    backend: undefined as unknown as DshContextBackend,
    warnings,
    calls,
    saves,
    resolveCalls,
    state,
    runtimeSelection: undefined,
    models,
    loaderEntries: [{ options: { id: 'agent-default-model', name: MODEL_PACKAGE } }],
    mutateError: undefined,
    reasoningError: undefined,
    reasoningErrorFor: undefined,
    resolveInfoFor: undefined,
    reasoningGate: undefined,
    mutateGate: undefined,
    providerFailures: new Map<string, Error>(),
    modelReads: [],
    readBackOverride: undefined,
    describeCount: 0,
  }

  host.use('agents', { create: async () => { throw new Error('no Agent may be created by a settings read') }, resume: async () => { throw new Error('no Agent may be resumed by a settings read') } })
  host.use('agentDefaultModel', {
    currentSelection: () => ({ ...(fixtureValue.runtimeSelection ?? state.selection) }),
    saveSelection: async (next: FixtureSelection) => {
      saves.push({ ...next })
      state.selection = { ...next }
      state.revision += 1
    },
  })
  host.use('llm', {
    listProviders: () => [...new Set(models.map(model => model.provider))].map(id => ({ id })),
    listModels: async (provider: string) => {
      fixtureValue.modelReads.push(provider)
      const failure = fixtureValue.providerFailures.get(provider)
      if (failure !== undefined) throw failure
      return models.filter(model => model.provider === provider)
        .map(model => ({ id: model.id, name: model.id, ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }) }))
    },
    resolveModelInfo: async (provider: string, model: string) => {
      resolveCalls.push(`${provider}/${model}`)
      if (fixtureValue.reasoningGate !== undefined) await fixtureValue.reasoningGate.promise
      if (fixtureValue.reasoningError !== undefined) throw fixtureValue.reasoningError
      if (fixtureValue.reasoningErrorFor?.pair === `${provider}/${model}`) throw fixtureValue.reasoningErrorFor.error
      if (fixtureValue.resolveInfoFor?.pair === `${provider}/${model}`) return fixtureValue.resolveInfoFor.payload
      const row = models.find(candidate => candidate.provider === provider && candidate.id === model)
      if (row === undefined) throw new Error(`unknown route ${provider}/${model}`)
      return row.reasoning === undefined ? {} : { reasoning: row.reasoning }
    },
  })
  host.use('settings', {
    describe: () => {
      fixtureValue.describeCount += 1
      const selection = fixtureValue.readBackOverride ?? state.selection
      return [{
        ns: 'agent-default-model',
        autoGenerate: false,
        schema: volatileSchema(['provider', 'model', 'reasoningEffort']),
        value: { ...selection },
        revision: state.revision,
        applies: 'live',
      }]
    },
    mutate: async (ns: string, ops: RecordedOp[], expectedRevision?: number) => {
      calls.push({ ns, ops: ops.map(op => ({ ...op, path: [...op.path] })), expectedRevision })
      if (fixtureValue.mutateGate !== undefined) await fixtureValue.mutateGate.promise
      if (fixtureValue.mutateError !== undefined) throw fixtureValue.mutateError
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw Object.assign(new Error('native revision moved'), {
          code: 'SETTINGS_CONFLICT',
          expected: expectedRevision,
          actual: state.revision,
        })
      }
      for (const op of ops) {
        const key = op.path[0]
        if (key !== 'provider' && key !== 'model' && key !== 'reasoningEffort') throw new Error(`unexpected path ${key}`)
        if (op.op === 'set') {
          if (key === 'reasoningEffort') state.selection = { ...state.selection, reasoningEffort: String(op.value) }
          else state.selection = { ...state.selection, [key]: String(op.value) }
        } else if (key === 'reasoningEffort') {
          const { reasoningEffort: _dropped, ...rest } = state.selection
          state.selection = rest
        } else {
          throw new Error('provider/model must never be unset')
        }
      }
      state.revision += 1
    },
  })
  host.use('loader', {
    entries: () => fixtureValue.loaderEntries.map(entry => ({ options: { ...entry.options } })),
  })
  options.extra?.(host)
  fixtureValue.backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: message => warnings.push(message),
    ...options.backend,
  })
  return fixtureValue
}

function target(read: unknown): Record<string, unknown> {
  const row = read as { targets?: unknown }
  assert.ok(Array.isArray(row.targets), 'native-defaults must return targets')
  const found = (row.targets as Array<Record<string, unknown>>).find(value => value.target === 'agent-default-model')
  assert.ok(found !== undefined, 'the agent-default-model target must be present')
  return found
}

function activeCommandCount(backend: DshContextBackend): number {
  return (backend as unknown as { activeCommands: Map<string, unknown> }).activeCommands.size
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(label)
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code, `expected ${code}, got ${String(error)}`)
    return true
  })
}

// ------------------------------------------------------------------ reads

test('native-defaults reports the persisted default pair and native levels, not the session route', async () => {
  const f = fixture({
    selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    // An explicit CLI route is a different native fact and must never be shown
    // as the startup default.
    backend: { provider: 'p9', model: 'm9' },
  })
  const info = await f.backend.connect()
  assert.equal(info.provider, 'p9')
  assert.ok(info.capabilities.includes('native-defaults'))
  assert.ok(info.capabilities.includes('native-default-update'))

  const view = target(await f.backend.command('native-defaults'))
  assert.equal(view.available, true)
  assert.equal(view.writable, true)
  assert.equal(view.namespace, 'agent-default-model')
  assert.equal(view.revision, 0)
  assert.equal(view.provider, 'p1')
  assert.equal(view.model, 'm1')
  assert.equal(view.value, 'p1/m1')
  assert.equal(view.reasoningEffort, 'high')
  assert.equal(view.defaultReasoningEffort, 'low')
  assert.equal(view.effectiveReasoningEffort, 'high')
  assert.equal(view.reasoningAvailable, true)
  assert.equal(view.reasoningSupported, true)
  assert.deepEqual((view.reasoningEfforts as Array<Record<string, unknown>>).map(level => level.id), ['low', 'high'])
  assert.deepEqual(view.options, [], 'the model picker owns the pair list; this target carries no options')
  assert.deepEqual(f.resolveCalls, ['p1/m1'], 'exactly one exact-route metadata read')
  assert.deepEqual(f.calls, [], 'a read never writes')
  assert.deepEqual(f.saves, [], 'a read never saves through the default service')
  assert.equal(activeCommandCount(f.backend), 0)
  await f.backend.close()
})

test('native-defaults distinguishes unsupported reasoning from unreadable metadata', async () => {
  const f = fixture({ models: [{ provider: 'p1', id: 'm1' }] })
  await f.backend.connect()

  const unsupported = target(await f.backend.command('native-defaults'))
  assert.equal(unsupported.reasoningAvailable, true)
  assert.equal(unsupported.reasoningSupported, false)
  assert.deepEqual(unsupported.reasoningEfforts, [])
  assert.equal(unsupported.defaultReasoningEffort, undefined)
  assert.equal(unsupported.effectiveReasoningEffort, undefined)
  assert.equal(unsupported.writable, true, 'a model with no levels is still a valid default model')

  f.reasoningError = new Error('synthetic metadata failure')
  const unreadable = target(await f.backend.command('native-defaults'))
  assert.equal(unreadable.reasoningAvailable, false)
  assert.equal(unreadable.reasoningSupported, undefined)
  // The effort choice is unavailable, but the proven native Settings write is
  // not: the model row is how a broken default gets repaired.
  assert.equal(unreadable.writable, true)
  assert.equal(unreadable.reason, 'options-unavailable')
  assert.match(String(unreadable.limitation), /reasoning metadata/i)
  assert.ok(f.warnings.some(message => /reasoning metadata/.test(message)), 'the metadata failure is reported')
  assert.equal(unreadable.provider, 'p1', 'the persisted config facts are still reported')
  await f.backend.close()
})

test('the default-model target is unavailable without a provable native namespace', async () => {
  const ambiguous = fixture()
  ambiguous.loaderEntries = [
    { options: { id: 'agent-default-model', name: MODEL_PACKAGE } },
    { options: { id: 'agent-default-model-2', name: MODEL_PACKAGE } },
  ]
  await ambiguous.backend.connect()
  const view = target(await ambiguous.backend.command('native-defaults'))
  assert.equal(view.available, false)
  assert.equal(view.reason, 'namespace-ambiguous')
  assert.equal(view.writable, false)
  const refused = await ambiguous.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'unavailable')
  assert.equal(ambiguous.calls.length, 0)
  await ambiguous.backend.close()

  const missing = fixture()
  missing.host.services.delete('settings')
  await missing.backend.connect()
  const read = await missing.backend.command('native-defaults') as Record<string, unknown>
  assert.equal(read.available, false)
  assert.equal(read.reason, 'missing-settings-service')
  const platform = await missing.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(platform.ok, false)
  assert.equal(platform.reason, 'unavailable')
  await missing.backend.close()
})

test('a mounted default service that does not read the profile entry is reported read-only', async () => {
  const f = fixture({
    selection: { provider: 'p1', model: 'm1' },
  })
  // The runtime default now names a route the profile entry does not carry.
  f.host.use('agentDefaultModel', { currentSelection: () => ({ provider: 'p1', model: 'm3' }) })
  await f.backend.connect()
  const view = target(await f.backend.command('native-defaults'))
  assert.equal(view.available, true)
  assert.equal(view.writable, false)
  assert.equal(view.reason, 'write-unavailable')
  assert.match(String(view.limitation), /does not read this profile entry/)
  const refused = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'unavailable')
  assert.equal(f.calls.length, 0)
  await f.backend.close()
})

// ----------------------------------------------------------------- writes

test('an effort-only write uses one fenced native mutate and honours null as native unset', async () => {
  const f = fixture()
  await f.backend.connect()

  const applied = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'high', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(applied.ok, true)
  assert.equal(applied.changed, true)
  assert.equal(applied.provider, 'p1')
  assert.equal(applied.model, 'm1')
  assert.equal(applied.reasoningEffort, 'high')
  assert.equal(applied.revision, 1)
  assert.deepEqual(f.calls, [{
    ns: 'agent-default-model',
    ops: [{ op: 'set', path: ['reasoningEffort'], value: 'high' }],
    expectedRevision: 0,
  }], 'one mutate carries the whole reasoned decision; the pair is untouched')

  const reset = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'm1', reasoningEffort: null, expectedRevision: 1,
  }) as Record<string, unknown>
  assert.equal(reset.ok, true)
  assert.equal(reset.changed, true)
  assert.equal(reset.reasoningEffortReset, true)
  assert.equal(reset.reasoningEffort, undefined)
  assert.deepEqual(f.calls[1], {
    ns: 'agent-default-model',
    ops: [{ op: 'unset', path: ['reasoningEffort'] }],
    expectedRevision: 1,
  })
  assert.equal(f.state.selection.reasoningEffort, undefined)
  await f.backend.close()
})

test('a model change carries only an advertised stored level and otherwise unsets it atomically', async () => {
  const f = fixture({ selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })
  await f.backend.connect()

  const carried = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(carried.ok, true)
  assert.equal(carried.changed, true)
  assert.equal(carried.reasoningEffort, 'high')
  assert.deepEqual(f.calls[0].ops, [
    { op: 'set', path: ['provider'], value: 'p1' },
    { op: 'set', path: ['model'], value: 'm2' },
  ], 'a still-advertised stored level survives and is not restated')

  const dropped = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m3', expectedRevision: 1,
  }) as Record<string, unknown>
  assert.equal(dropped.ok, true)
  assert.equal(dropped.changed, true)
  assert.equal(dropped.reasoningEffortReset, true)
  assert.deepEqual(f.calls[1].ops, [
    { op: 'set', path: ['provider'], value: 'p1' },
    { op: 'set', path: ['model'], value: 'm3' },
    { op: 'unset', path: ['reasoningEffort'] },
  ], 'one mutate carries the pair and the removal together')
  assert.equal(f.state.selection.model, 'm3')
  assert.equal(f.state.selection.reasoningEffort, undefined)
  await f.backend.close()
})

test('unknown model rows and unknown levels fail before any native write', async () => {
  const f = fixture()
  await f.backend.connect()

  const unknownModel = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p9/m9', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(unknownModel.ok, false)
  assert.equal(unknownModel.reason, 'not-an-option')

  const unknownLevel = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'ultra', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(unknownLevel.ok, false)
  assert.equal(unknownLevel.reason, 'not-an-option')
  assert.match(String(unknownLevel.message), /low, high/)
  assert.deepEqual(f.calls, [], 'no native mutation for a refused selection')
  await f.backend.close()
})

test('an all-failed native model catalog reports the provider failure instead of a fabricated empty catalog', async () => {
  const f = fixture()
  await f.backend.connect()
  f.providerFailures.set('p1', new Error('no adapter registered for provider "p1" (Authorization: Bearer sk-catalog-secret)'))

  const result = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unavailable', 'a failed provider read is not "this model does not exist"')
  const message = String(result.message)
  assert.match(message, /native model catalog could not be read/)
  assert.match(message, /p1: no adapter registered for provider "p1"/, 'the native provider failure is carried')
  assert.match(message, /\[redacted\]/, 'the failure text is reported but stays redacted')
  assert.doesNotMatch(message, /sk-catalog-secret/, 'no credential is echoed into the refusal')
  assert.doesNotMatch(message, /does not advertise/, 'a failed read is never a fabricated empty success catalog')
  assert.deepEqual(f.calls, [], 'no native mutation')
  assert.deepEqual(f.resolveCalls, [], 'an unreadable catalog needs no exact-route metadata read')
  assert.ok(
    f.warnings.some(warning => /could not read some native model providers/.test(warning)),
    'the isolated provider failure is reported as a diagnostic too',
  )
  await f.backend.close()
})

test('a partially failed native catalog still selects a loaded row and reports the outage', async () => {
  const f = fixture({
    models: [
      { provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } },
      { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p2', id: 'x1' },
    ],
  })
  await f.backend.connect()
  f.providerFailures.set('p2', new Error('p2 credential missing'))

  const applied = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(applied.ok, true, 'the loaded rows stay selectable when another provider failed')
  assert.equal(applied.provider, 'p1')
  assert.equal(applied.model, 'm2')
  assert.equal(f.calls.length, 1, 'one fenced native mutate')
  assert.deepEqual([...f.modelReads].sort(), ['p1', 'p2'], 'the whole mounted catalog was read, never a cached subset')
  assert.ok(f.warnings.some(warning => /p2: p2 credential missing/.test(warning)))

  // A row from the failed provider is not silently "unknown": the refusal keeps
  // the native failure so a provider outage is distinguishable from a bad id.
  const unknown = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p2/x1', expectedRevision: 1,
  }) as Record<string, unknown>
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'not-an-option')
  assert.match(String(unknown.message), /does not advertise "p2\/x1"/)
  assert.match(String(unknown.message), /p2: p2 credential missing/, 'the isolated failure is part of the refusal')
  assert.equal(f.calls.length, 1, 'the refused row wrote nothing')
  await f.backend.close()
})

test('an already-stale confirmed revision is a conflict before any catalog or metadata read', async () => {
  const changing = fixture()
  await changing.backend.connect()
  // The native document has moved since the read was confirmed. A catalog read
  // here would be up to 8s of wasted native work for a write that cannot apply.
  changing.state.revision = 4
  changing.reasoningGate = deferred()
  const conflict = await changing.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(conflict.ok, false)
  assert.equal(conflict.reason, 'conflict')
  assert.equal(conflict.expectedRevision, 0)
  assert.equal(conflict.actualRevision, 4)
  assert.equal((conflict.current as Record<string, unknown>).revision, 4, 'the fresh native view is returned')
  assert.deepEqual(changing.modelReads, [], 'no native catalog read is paid for a stale confirmation')
  assert.deepEqual(changing.resolveCalls, [], 'no exact-route metadata read either')
  assert.deepEqual(changing.calls, [], 'no native mutation')
  assert.equal(activeCommandCount(changing.backend), 0)
  await changing.backend.close()

  // The same fence holds for an effort-only edit, which would otherwise pay
  // only the bounded metadata read.
  const effort = fixture({ selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })
  await effort.backend.connect()
  effort.state.revision = 2
  const stale = await effort.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'low', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(stale.ok, false)
  assert.equal(stale.reason, 'conflict')
  assert.equal(stale.actualRevision, 2)
  assert.deepEqual(effort.resolveCalls, [], 'the exact-route metadata read is not paid either')
  assert.deepEqual(effort.calls, [])
  await effort.backend.close()
})

test('stale revision is a native conflict, and a failed write is reported without a success claim', async () => {
  const f = fixture()
  await f.backend.connect()

  const conflict = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 7,
  }) as Record<string, unknown>
  assert.equal(conflict.ok, false)
  assert.equal(conflict.reason, 'conflict')
  assert.equal(conflict.actualRevision, 0)
  assert.equal(f.calls.length, 0, 'the native fence is checked before the mutation')

  f.mutateError = new Error('synthetic native write refusal')
  const failed = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, 'write-failed')
  assert.match(String(failed.message), /synthetic native write refusal/)
  assert.ok(f.warnings.some(message => /native default model write failed/.test(message)))
  await f.backend.close()
})

test('a read-back that disagrees with the request is changed:false and returns the native value', async () => {
  const f = fixture({
    models: [
      { provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'high' }] } },
    ],
  })
  await f.backend.connect()
  // The native write is accepted, but the composed document still holds the old
  // pair: the outcome must report the read-back value, never the request.
  f.readBackOverride = { provider: 'p1', model: 'm1' }
  const result = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', reasoningEffort: 'high', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.value, 'p1/m1', 'value is the native read-back pair, not the requested pair')
  assert.equal(result.provider, 'p1')
  assert.equal(result.model, 'm1')
  assert.equal(result.reasoningEffort, undefined)
  await f.backend.close()
})

// ------------------------------------- repair path / broken saved pair

test('a broken saved pair keeps the target writable so a valid native model can replace it', async () => {
  const f = fixture({ selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })
  // The persisted pair's adapter metadata is unreadable (e.g. a stale or
  // misregistered route); the catalog itself still lists valid routes.
  f.reasoningErrorFor = { pair: 'p1/m1', error: new Error('no adapter registered for provider "p1"') }
  await f.backend.connect()

  const view = target(await f.backend.command('native-defaults'))
  assert.equal(view.available, true)
  assert.equal(view.writable, true, 'an unreadable roster must not lock the repair path')
  assert.equal(view.reasoningAvailable, false)
  assert.equal(view.reason, 'options-unavailable')
  assert.match(String(view.limitation), /reasoning metadata/i)
  assert.equal(view.provider, 'p1')
  assert.equal(view.model, 'm1')
  assert.equal(view.reasoningEffort, 'high', 'the stored level is still reported as the native fact')

  // The native write path is unchanged: one fenced mutate through the catalog.
  const repaired = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(repaired.ok, true)
  assert.equal(repaired.changed, true)
  assert.equal(repaired.model, 'm2')
  assert.deepEqual(f.calls, [{
    ns: 'agent-default-model',
    ops: [
      { op: 'set', path: ['provider'], value: 'p1' },
      { op: 'set', path: ['model'], value: 'm2' },
      // The old pair could not advertise the level; the NEW pair does, so the
      // native stored level is carried and not restated.
    ],
    expectedRevision: 0,
  }], 'one mutate carries the whole repaired selection')
  await f.backend.close()
})

test('a repair carries or drops the stored level only by the NEW model metadata', async () => {
  const f = fixture({
    selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    models: [
      { provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p1', id: 'm3', reasoning: { efforts: [{ id: 'low' }] } },
    ],
  })
  f.reasoningErrorFor = { pair: 'p1/m1', error: new Error('stale route metadata') }
  await f.backend.connect()

  const carried = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(carried.ok, true)
  assert.equal(carried.reasoningEffort, 'high')
  assert.deepEqual(f.calls[0].ops, [
    { op: 'set', path: ['provider'], value: 'p1' },
    { op: 'set', path: ['model'], value: 'm2' },
  ], 'the new model advertises the stored level, so it survives')

  const dropped = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m3', expectedRevision: 1,
  }) as Record<string, unknown>
  assert.equal(dropped.ok, true)
  assert.equal(dropped.reasoningEffortReset, true)
  assert.deepEqual(f.calls[1].ops, [
    { op: 'set', path: ['provider'], value: 'p1' },
    { op: 'set', path: ['model'], value: 'm3' },
    { op: 'unset', path: ['reasoningEffort'] },
  ], 'the new model does not advertise it, so the native unset removes it')
  await f.backend.close()
})

test('a model switch with unreadable NEW metadata still applies and unsets the stored level', async () => {
  const f = fixture({
    selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    models: [
      { provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'low' }] } },
      { provider: 'p1', id: 'm3', reasoning: { efforts: [{ id: 'high' }] } },
    ],
  })
  f.reasoningErrorFor = { pair: 'p1/m2', error: new Error('adapter metadata unavailable') }
  await f.backend.connect()

  // A stored level exists and the new target's roster is unreadable, so the
  // carry decision cannot be proven. The switch itself is the repair path and
  // must not be refused: the level is omitted exactly like native
  // `saveSelection()` does, which is one `unset` in the same mutate.
  const switched = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(switched.ok, true)
  assert.equal(switched.changed, true)
  assert.equal(switched.provider, 'p1')
  assert.equal(switched.model, 'm2')
  assert.equal(switched.reasoningEffort, undefined)
  assert.equal(switched.reasoningEffortReset, true, 'the unprovable stored level is reported as removed')
  assert.deepEqual(f.calls, [{
    ns: 'agent-default-model',
    ops: [
      { op: 'set', path: ['provider'], value: 'p1' },
      { op: 'set', path: ['model'], value: 'm2' },
      { op: 'unset', path: ['reasoningEffort'] },
    ],
    expectedRevision: 0,
  }], 'one mutate carries the switch and the removal together')
  assert.equal(f.state.selection.model, 'm2')
  assert.equal(f.state.selection.reasoningEffort, undefined)

  // An explicit level on that same unreadable target is still refused: it
  // cannot be validated, and an explicit request is never silently dropped.
  f.state.revision = 1
  const explicit = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', reasoningEffort: 'low', expectedRevision: 1,
  }) as Record<string, unknown>
  assert.equal(explicit.ok, false)
  assert.equal(explicit.reason, 'unavailable')
  assert.equal(f.calls.length, 1, 'no metadata decision means no second native mutation')

  // The runtime owner mismatch stays a read-only refusal (different condition).
  f.host.use('agentDefaultModel', { currentSelection: () => ({ provider: 'p1', model: 'm9' }) })
  const owned = target(await f.backend.command('native-defaults'))
  assert.equal(owned.writable, false)
  assert.equal(owned.reason, 'write-unavailable')
  await f.backend.close()
})

test('an explicit level on unreadable metadata is refused with zero mutations', async () => {
  const f = fixture({
    selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' },
    models: [
      { provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'low' }] } },
    ],
  })
  f.reasoningErrorFor = { pair: 'p1/m2', error: new Error('adapter metadata unavailable') }
  await f.backend.connect()

  const explicit = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', reasoningEffort: 'low', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(explicit.ok, false)
  assert.equal(explicit.reason, 'unavailable')
  assert.match(String(explicit.message), /reasoning metadata/i)
  assert.deepEqual(f.calls, [], 'an unvalidatable explicit level is never written')
  assert.equal(f.state.selection.model, 'm1', 'the stored pair is untouched')
  await f.backend.close()
})

test('confirming the current default model is a successful no-op with the native read-back shape', async () => {
  const f = fixture({ selection: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })
  await f.backend.connect()
  const describesBefore = f.describeCount

  // The model picker's own current row: the request carries the persisted pair
  // and no level, so there is nothing to write.
  const confirmed = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(confirmed.ok, true, 'the current row stays confirmable')
  assert.equal(confirmed.changed, false)
  assert.equal(confirmed.target, 'agent-default-model')
  assert.equal(confirmed.namespace, 'agent-default-model')
  assert.equal(confirmed.field, 'provider,model,reasoningEffort')
  assert.equal(confirmed.value, 'p1/m1', 'the outcome carries the native read-back value')
  assert.equal(confirmed.revision, 0, 'the outcome carries the current native revision')
  assert.equal(confirmed.provider, 'p1')
  assert.equal(confirmed.model, 'm1')
  assert.equal(confirmed.reasoningEffort, 'high')
  assert.equal(confirmed.reasoningEffortReset, undefined)
  assert.equal(confirmed.stillCurrent, true)
  assert.deepEqual(f.calls, [], 'a no-op never mutates')
  assert.ok(f.describeCount > describesBefore, 'the shape comes from a fresh native read-back, not the confirmation')
  assert.equal(f.state.revision, 0, 'no write means no revision move')

  // The bare model id is the same effort-only confirmation.
  const byModel = await f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'm1', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(byModel.ok, true)
  assert.equal(byModel.changed, false)
  assert.deepEqual(f.calls, [])

  await f.backend.close()
})

test('malformed native metadata is unknown, never a known "no reasoning levels"', async () => {
  const repaired = fixture({
    models: [
      { provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'high' }] } },
      { provider: 'p1', id: 'm2', reasoning: { efforts: [{ id: 'high' }] } },
    ],
  })
  // A non-record model-info result is malformed, not an empty roster.
  repaired.resolveInfoFor = { pair: 'p1/m1', payload: 'not-a-model-info' }
  await repaired.backend.connect()
  const unknown = target(await repaired.backend.command('native-defaults'))
  assert.equal(unknown.available, true)
  assert.equal(unknown.reasoningAvailable, false)
  assert.equal(unknown.reasoningSupported, undefined, 'unknown metadata is not a known empty roster')
  assert.equal(unknown.reasoningEfforts, undefined)
  assert.equal(unknown.reason, 'options-unavailable')
  assert.match(String(unknown.limitation), /reasoning metadata/i)
  assert.equal(unknown.writable, true, 'the repair path stays available')

  const repair = await repaired.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m2', expectedRevision: 0,
  }) as Record<string, unknown>
  assert.equal(repair.ok, true)
  assert.equal(repair.changed, true)
  assert.equal(repaired.calls.length, 1)
  await repaired.backend.close()

  for (const payload of [{ reasoning: 42 }, { reasoning: null }]) {
    const malformed = fixture({ models: [{ provider: 'p1', id: 'm1', reasoning: { efforts: [{ id: 'high' }] } }] })
    malformed.resolveInfoFor = { pair: 'p1/m1', payload }
    await malformed.backend.connect()
    const view = target(await malformed.backend.command('native-defaults'))
    assert.equal(view.reasoningAvailable, false, `${JSON.stringify(payload)} is malformed metadata`)
    assert.equal(view.reasoningSupported, undefined)
    assert.equal(view.writable, true)
    await malformed.backend.close()
  }
})

test('a namespace/owner change during the metadata read refuses the obsolete mutation', async () => {
  for (const scenario of ['second-entry', 'moved-namespace'] as const) {
    const f = fixture()
    await f.backend.connect()
    const hold = deferred()
    f.reasoningGate = hold
    const pending = f.backend.command('native-default-update', {
      target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'high', expectedRevision: 0,
    }) as Promise<Record<string, unknown>>
    await until(() => activeCommandCount(f.backend) === 1, 'the default write is registered')
    // The captured descriptor and its revision stay exactly as they were; only
    // the live Loader ownership changes while the metadata read is held.
    f.loaderEntries = scenario === 'second-entry'
      ? [
          { options: { id: 'agent-default-model', name: MODEL_PACKAGE } },
          { options: { id: 'agent-default-model-2', name: MODEL_PACKAGE } },
        ]
      : [{ options: { id: 'agent-default-model-moved', name: MODEL_PACKAGE } }]
    hold.release()
    const result = await pending
    assert.equal(result.ok, false, `${scenario}: the obsolete namespace must not be written`)
    assert.equal(result.reason, 'unavailable', scenario)
    assert.deepEqual(f.calls, [], `${scenario}: no native mutation`)
    await f.backend.close()
  }
})

test('a runtime owner selection that moves independently of the descriptor refuses the write', async () => {
  const f = fixture()
  await f.backend.connect()
  const hold = deferred()
  f.reasoningGate = hold
  const pending = f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'high', expectedRevision: 0,
  }) as Promise<Record<string, unknown>>
  await until(() => activeCommandCount(f.backend) === 1, 'the default write is registered')
  // The mounted owner now reports another pair; the descriptor and its revision
  // are untouched, so no native settings write produced this change.
  f.runtimeSelection = { provider: 'p1', model: 'm2' }
  hold.release()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'conflict')
  assert.deepEqual(f.calls, [], 'a moved native owner is never written against a stale descriptor')
  await f.backend.close()
})

// ------------------------------------------- cancellation / race / bounds

test('a revision that moves during the metadata read is a conflict before any write', async () => {
  const f = fixture()
  await f.backend.connect()
  const hold = deferred()
  f.reasoningGate = hold
  const pending = f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'high', expectedRevision: 0,
  }) as Promise<Record<string, unknown>>
  await until(() => activeCommandCount(f.backend) === 1, 'the default write is registered')
  f.state.revision = 3
  hold.release()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'conflict')
  assert.equal(result.actualRevision, 3)
  assert.deepEqual(f.calls, [], 'the obsolete selection is never written')
  await f.backend.close()
})

test('an attachment change during the metadata read rejects the obsolete write', async () => {
  const f = fixture()
  await f.backend.connect()
  const hold = deferred()
  f.reasoningGate = hold
  const pending = f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'high', expectedRevision: 0,
  }) as Promise<unknown>
  await until(() => activeCommandCount(f.backend) === 1, 'the default write is registered')
  await f.backend.command('new')
  hold.release()
  await rejectsWithCode(pending, 'STALE_SESSION')
  assert.deepEqual(f.calls, [], 'a moved attachment never reaches the native mutation')
  await f.backend.close()
})

test('close during the metadata read aborts the carrier and writes nothing', async () => {
  const f = fixture()
  await f.backend.connect()
  const hold = deferred()
  f.reasoningGate = hold
  const pending = f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', reasoningEffort: 'high', expectedRevision: 0,
  }) as Promise<unknown>
  await until(() => activeCommandCount(f.backend) === 1, 'the default write is registered')
  const closing = f.backend.close()
  hold.release()
  await rejectsWithCode(pending, 'ABORTED')
  await closing
  assert.deepEqual(f.calls, [], 'a closed backend never writes a late default')
})

// --------------------------------------------- preserved current semantics

test('the session model/effort commands keep their native default-saving side effect', async () => {
  const f = fixture()
  await f.backend.connect()

  const model = await f.backend.command('model', { id: 'p1/m2' }) as Record<string, unknown>
  assert.equal(model.provider, 'p1')
  assert.equal(model.model, 'm2')
  assert.deepEqual(f.saves, [{ provider: 'p1', model: 'm2' }], '/model still submits the native default')

  const effort = await f.backend.command('effort', { id: 'high' }) as Record<string, unknown>
  assert.equal(effort.provider, 'p1')
  assert.equal(effort.model, 'm2')
  assert.deepEqual(f.saves.at(-1), { provider: 'p1', model: 'm2', reasoningEffort: 'high' },
    '/effort still submits the complete native default selection')
  assert.deepEqual(f.calls, [], 'the session commands do not use the settings write path')
  await f.backend.close()
})

test('native-default-update validates the new target and refuses effort on other targets', async () => {
  const f = fixture()
  await f.backend.connect()
  await rejectsWithCode(f.backend.command('native-default-update', {
    target: 'agent-preset-default', value: 'standard', expectedRevision: 0, reasoningEffort: 'high',
  }), 'INVALID_ARGUMENT')
  await rejectsWithCode(f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', expectedRevision: 0, reasoningEffort: 42,
  }), 'INVALID_ARGUMENT')
  await rejectsWithCode(f.backend.command('native-default-update', {
    target: 'agent-default-model', value: 'p1/m1', expectedRevision: 0, reasoningEffort: '',
  }), 'INVALID_ARGUMENT')
  await rejectsWithCode(f.backend.command('native-default-update', {
    target: 'model-default', value: 'p1/m1', expectedRevision: 0,
  }), 'INVALID_ARGUMENT')
  await f.backend.close()
})