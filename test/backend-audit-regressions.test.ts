/**
 * Offline regression tests for four audited adapter correctness defects:
 *
 * - A5: a native `commands/change` invalidation exists and names the current
 *   live/pending surface (no TUI command registry, no poll, no stale ids).
 * - A6: the `/models` `default` badge comes from the native default-model
 *   service, never from the live Agent or a pending/CLI route.
 * - A7: a failed/unavailable title observation is omitted, while a fulfilled
 *   native no-title observation stays `null` (partial batches included).
 * - A9: an option-less free-text answer is encoded as `custom`, not as a
 *   selected option label.
 *
 * Every service is a synthetic local fake: no profile, credential, session
 * log, provider, network request or subprocess is touched.
 *
 * @module dsh-tui/test/backend-audit-regressions
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import type { BackendEvent, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, type FakeAgentState } from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
  warnings: string[]
}

function harness(
  extra: (host: FakeDshHost, value: Harness) => void = () => {},
  options: Partial<DshContextBackendOptions> = {},
): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const warnings: string[] = []
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    saveSelection: async () => {},
  })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }),
  })
  host.use('commands', {
    list: () => [{ name: 'permission', description: 'Change permissions' }],
    execute: async () => ({ commandId: 'command-1', result: { kind: 'success' } }),
  })
  const events: BackendEvent[] = []
  const value: Harness = {
    host,
    agents,
    events,
    warnings,
    backend: createDshBackend(host, {
      cwd: '/workspace',
      native: fakeNativeHelpers(),
      warn: message => { warnings.push(message) },
      ...options,
    }),
  }
  extra(host, value)
  value.backend.onEvent(event => events.push(event))
  return value
}

function latestAgent(list: readonly FakeAgentState[]): FakeAgentState {
  const agent = list[list.length - 1]
  assert.ok(agent, 'the fake registry created an Agent')
  return agent
}

function changes(events: readonly BackendEvent[]): BackendEvent[] {
  return events.filter(event => event.type === 'commands_changed')
}

// --------------------------------------------------------------------- A5

test('A5: native commands/change invalidates the current surface and never a TUI registry', async () => {
  let roster: Array<Record<string, unknown>> = [{ name: 'permission', description: 'Change permissions' }]
  const agentsListed: unknown[] = []
  const h = harness((host) => {
    host.use('commands', {
      list: (agent?: unknown) => {
        agentsListed.push(agent)
        return roster
      },
      execute: async () => ({ commandId: 'command-1', result: { kind: 'success' } }),
    })
  })
  const pending = await h.backend.connect()

  // The adapter subscribes to the declared native registry notification.
  assert.equal(h.host.listenerCount('commands/change'), 1, 'the adapter observes the native commands/change event')
  const beforeListing = await h.backend.command('commands') as Array<Record<string, unknown>>
  assert.deepEqual(beforeListing.map(item => item.name), ['permission'])
  assert.deepEqual(agentsListed, [undefined], 'the pending roster read is the existing native call, not an extra one')

  // A late native registration: the adapter only invalidates; the consumer
  // re-reads the native roster and sees the new command.
  roster = [...roster, { name: 'late-native', description: 'registered after startup' }]
  assert.equal(changes(h.events).length, 0, 'nothing is emitted before the native registry reports a change')
  h.host.emit('commands/change')
  assert.deepEqual(changes(h.events), [{
    type: 'commands_changed', sessionId: pending.sessionId, attachmentId: pending.attachmentId,
  }], 'the pending attachment is the current surface')
  assert.equal(agentsListed.length, 1, 'the adapter itself never re-reads or polls the native roster')
  const refetched = await h.backend.command('commands') as Array<Record<string, unknown>>
  assert.deepEqual(refetched.map(item => item.name), ['permission', 'late-native'], 'the consumer re-read is native truth')

  // Unrelated native notifications never masquerade as a command change.
  const afterPending = changes(h.events).length
  h.host.emit('skills/change')
  assert.equal(changes(h.events).length, afterPending, 'a skills/change is not a commands_changed')

  // Live attachment: the pending attachment is committed in place, so the
  // invalidation still carries the exact current ids.
  h.agents.route = { provider: 'p1', model: 'm1' }
  await h.backend.send('prompt')
  const live = await h.backend.connect()
  assert.equal(live.sessionId, pending.sessionId, 'the same native session was materialized')
  assert.equal(live.attachmentId, pending.attachmentId, 'the committed attachment keeps its epoch id')
  h.host.emit('commands/change')
  const liveChange = changes(h.events).at(-1)
  assert.deepEqual(liveChange, {
    type: 'commands_changed', sessionId: live.sessionId, attachmentId: live.attachmentId,
  }, 'the live Agent attachment is the current surface')

  // A scoped/child registration, or any registration after an attachment
  // switch, still names only the current surface: a retired attachment is
  // never revalidated.
  const replaced = await h.backend.command('new') as SessionInfo
  assert.notEqual(replaced.attachmentId, live.attachmentId)
  h.host.emit('commands/change')
  assert.deepEqual(changes(h.events).at(-1), {
    type: 'commands_changed', sessionId: replaced.sessionId, attachmentId: replaced.attachmentId,
  }, 'the invalidation follows the current attachment')

  // Disposal guard: the host subscription belongs to the adapter lifecycle.
  const total = changes(h.events).length
  await h.backend.close()
  assert.equal(h.host.listenerCount('commands/change'), 0, 'the commands/change subscription is disposed with the adapter')
  h.host.emit('commands/change')
  assert.equal(changes(h.events).length, total, 'no invalidation after close')
})

// --------------------------------------------------------------------- A6

test('A6: the /models default badge is the native default selection, not the pending route', async () => {
  const defaultCalls: number[] = []
  const nativeDefault = { provider: 'p1', model: 'm1' }
  const h = harness((host) => {
    host.use('agentDefaultModel', {
      currentSelection: () => {
        defaultCalls.push(1)
        return { ...nativeDefault }
      },
      // A host without a mounted ConfigEditor: the native service silently
      // returns without persisting, so the default stays p1/m1.
      saveSelection: async () => {},
    })
    host.use('llm', {
      listProviders: () => [{ id: 'p1' }, { id: 'p2' }],
      listModels: async (provider: string) => provider === 'p1' ? [{ id: 'm1' }] : [{ id: 'mx' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }),
    })
  }, { provider: 'p2', model: 'mx' })
  const pending = await h.backend.connect()
  assert.equal(pending.provider, 'p2', 'the explicit route still wins for the session (route precedence unchanged)')
  assert.equal(pending.model, 'mx')

  const pendingRows = await h.backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(pendingRows.map(row => [row.id, row.isDefault]), [
    ['p1/m1', true],
    ['p2/mx', undefined],
  ], 'only the native default is marked while the pending route is explicit')
  assert.ok(defaultCalls.length >= 1, 'the marker is read from the native default service')

  // Live attachment whose current route differs from the native default.
  h.agents.route = { provider: 'p2', model: 'mx' }
  await h.backend.send('prompt')
  const agent = latestAgent(h.agents.agents)
  assert.deepEqual(agent.route, { provider: 'p2', model: 'mx' })
  const liveRows = await h.backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(liveRows.map(row => [row.id, row.isDefault]), [
    ['p1/m1', true],
    ['p2/mx', undefined],
  ], 'a live session route is not the deployment default')

  // Selecting a route that the host does not persist never relabels it.
  await h.backend.command('model', { id: 'p2/mx' })
  assert.deepEqual(agent.route, { provider: 'p2', model: 'mx' }, 'the selection still applies to the session')
  const afterSelect = await h.backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(afterSelect.map(row => [row.id, row.isDefault]), [
    ['p1/m1', true],
    ['p2/mx', undefined],
  ], 'an unpersisted selection does not become the default marker')

  // Positive control: the marker follows the native default when it changes.
  nativeDefault.provider = 'p2'
  nativeDefault.model = 'mx'
  const moved = await h.backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(moved.map(row => [row.id, row.isDefault]), [
    ['p1/m1', undefined],
    ['p2/mx', true],
  ], 'the native default getter is the only marker source')
  await h.backend.close()
})

test('A6: an absent or failing native default read marks no default instead of guessing', async () => {
  const absent = harness((host) => {
    host.use('llm', {
      listProviders: () => [{ id: 'p1' }],
      listModels: async () => [{ id: 'm1' }],
      resolveModelInfo: async () => ({}),
    })
    host.services.delete('agentDefaultModel')
  })
  await absent.backend.connect()
  const rows = await absent.backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(rows.map(row => [row.id, row.isDefault]), [['p1/m1', undefined]], 'no invented default without the native service')
  await absent.backend.close()

  const failing = harness((host) => {
    host.use('agentDefaultModel', { currentSelection: () => { throw new Error('synthetic default read failure') } })
    host.use('llm', {
      listProviders: () => [{ id: 'p1' }, { id: 'p2' }],
      listModels: async (provider: string) => provider === 'p1' ? [{ id: 'm1' }] : [{ id: 'mx' }],
      resolveModelInfo: async () => ({}),
    })
  })
  await failing.backend.connect()
  failing.agents.route = { provider: 'p2', model: 'mx' }
  await failing.backend.send('prompt')
  const live = await failing.backend.connect()
  assert.equal(live.provider, 'p2', 'the live session route is still the mounted Agent route')
  assert.deepEqual(failing.warnings, [], 'a default read failure is not a diagnostic, only an unknown marker')
  const fallbackRows = await failing.backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(
    fallbackRows.map(row => [row.id, row.isDefault]),
    [['p1/m1', undefined], ['p2/mx', undefined]],
    'a failing default read marks nothing instead of promoting the live route',
  )
  await failing.backend.close()
})

// --------------------------------------------------------------------- A7

interface TitleObservation {
  sessionId: string
  status: 'fulfilled' | 'rejected'
  value?: Record<string, unknown>
  reason?: unknown
}

function sessionQueryWith(options: {
  rows: Array<Record<string, unknown>>
  titles?: (ids: readonly string[]) => Promise<TitleObservation[]>
}): Record<string, unknown> {
  return {
    listSessions: async () => options.rows,
    readSession: async (id: string) => ({ session: { id }, events: [], inheritedEventCount: 0 }),
    ...(options.titles === undefined ? {} : { readTitleSnapshots: options.titles }),
  }
}

test('A7: session listing distinguishes an unavailable title from a native no-title', async () => {
  const rows = [
    { header: { id: 's1', cwd: '/w', createdAt: 10 }, live: false },
    { header: { id: 's2', cwd: '/w', createdAt: 20 }, live: false },
    { header: { id: 's3', cwd: '/w', createdAt: 30 }, live: false },
  ]
  // Partial native batch: one titled, one fulfilled-without-title, one rejected.
  const partial = harness((host) => {
    host.use('sessionQuery', sessionQueryWith({
      rows,
      titles: async (ids) => [
        ...ids.filter(id => id === 's1').map(id => ({ sessionId: id, status: 'fulfilled' as const, value: { title: { title: 'native title' } } })),
        ...ids.filter(id => id === 's2').map(id => ({ sessionId: id, status: 'fulfilled' as const, value: {} })),
        ...ids.filter(id => id === 's3').map(id => ({ sessionId: id, status: 'rejected' as const, reason: new Error('unreadable log') })),
      ],
    }))
  })
  await partial.backend.connect()
  const sessions = await partial.backend.command('sessions') as Array<Record<string, unknown>>
  assert.equal(sessions[0]?.id, 's1')
  assert.equal(sessions[0]?.title, 'native title', 'a fulfilled native title is preserved')
  assert.equal(Object.hasOwn(sessions[1] ?? {}, 'title'), true, 'a fulfilled observation without a title is a fact')
  assert.equal(sessions[1]?.title, null, 'the native no-title fact stays null')
  assert.equal(Object.hasOwn(sessions[2] ?? {}, 'title'), false, 'a rejected observation is omitted, not null')
  await partial.backend.close()

  // A whole failed batch and an absent service are both unknown, never null.
  const failing = harness((host) => {
    host.use('sessionQuery', sessionQueryWith({
      rows,
      titles: async () => { throw new Error('synthetic title store failure') },
    }))
  })
  await failing.backend.connect()
  const failed = await failing.backend.command('sessions') as Array<Record<string, unknown>>
  assert.deepEqual(failed.map(row => Object.hasOwn(row, 'title')), [false, false, false], 'a failed batch omits every title')
  assert.ok(failing.warnings.some(message => /session titles/.test(message)), 'the failure stays a host diagnostic')
  assert.equal(failing.events.some(event => event.type === 'warning'), false, 'a title enrichment failure is not a conversation error')
  await failing.backend.close()

  const absent = harness((host) => {
    host.use('sessionQuery', sessionQueryWith({ rows }))
  })
  await absent.backend.connect()
  const unavailable = await absent.backend.command('sessions') as Array<Record<string, unknown>>
  assert.deepEqual(unavailable.map(row => Object.hasOwn(row, 'title')), [false, false, false], 'an absent title service omits every title')

  // The explicit opt-out keeps the field absent too (unchanged contract).
  const optOut = await absent.backend.command('sessions', { titles: false }) as Array<Record<string, unknown>>
  assert.deepEqual(optOut.map(row => Object.hasOwn(row, 'title')), [false, false, false])
  await absent.backend.close()
})

test('A7: the titles command preserves the same unknown/no-title distinction per row', async () => {
  const titled = harness((host) => {
    host.use('sessionQuery', sessionQueryWith({
      rows: [],
      titles: async (ids) => ids.map((id) => {
        if (id === 'known') return { sessionId: id, status: 'fulfilled' as const, value: { title: { title: 'Known' } } }
        if (id === 'empty') return { sessionId: id, status: 'fulfilled' as const, value: {} }
        return { sessionId: id, status: 'rejected' as const, reason: new Error('unreadable') }
      }),
    }))
  })
  await titled.backend.connect()
  const rows = await titled.backend.command('titles', { ids: ['known', 'empty', 'broken', 'known'] }) as Array<Record<string, unknown>>
  assert.deepEqual(rows, [
    { sessionId: 'known', title: 'Known' },
    { sessionId: 'empty', title: null },
    { sessionId: 'broken' },
  ], 'deduplicated rows keep string/null/omitted exactly as the native observation reported')
  await titled.backend.close()

  const failing = harness((host) => {
    host.use('sessionQuery', sessionQueryWith({
      rows: [],
      titles: async () => { throw new Error('synthetic title store failure') },
    }))
  })
  await failing.backend.connect()
  const failed = await failing.backend.command('titles', { ids: ['a', 'b'] }) as Array<Record<string, unknown>>
  assert.deepEqual(failed, [{ sessionId: 'a' }, { sessionId: 'b' }], 'a failed batch claims no title at all')
  await failing.backend.close()

  const absent = harness((host) => {
    host.use('sessionQuery', sessionQueryWith({ rows: [] }))
  })
  await absent.backend.connect()
  assert.deepEqual(
    await absent.backend.command('titles', { ids: ['a'] }),
    [{ sessionId: 'a' }],
    'an absent title service claims no title',
  )
  await absent.backend.close()
})

// --------------------------------------------------------------------- A9

async function questionAnswer(
  h: Harness,
  questions: readonly Record<string, unknown>[],
  answer: unknown,
): Promise<unknown> {
  const pending = h.host.waterfall('user-questions/request', {
    agent: latestAgent(h.agents.agents),
    questions,
  })
  const decision = h.events.filter(event => event.type === 'decision').at(-1)
  assert.ok(decision?.type === 'decision', 'the native question request reached the UI')
  assert.equal(decision.request.kind, 'question')
  await h.backend.respond(decision.request.id, answer)
  return await pending
}

test('A9: an option-less free-text answer is custom, never a selected option label', async () => {
  const h = harness()
  await h.backend.connect()
  await h.backend.send('prompt')

  assert.deepEqual(
    await questionAnswer(h, [{ id: 'free', question: 'Which branch?', header: 'Branch' }], { answers: [['feature/x']] }),
    { answers: [{ id: 'free', selected: [], custom: 'feature/x' }] },
    'typed text for a question without options is the native custom answer',
  )
  // A plain string answer (not wrapped in an array) takes the same path.
  assert.deepEqual(
    await questionAnswer(h, [{ id: 'free', question: 'Which branch?' }], { answers: ['feature/y'] }),
    { answers: [{ id: 'free', selected: [], custom: 'feature/y' }] },
    'the scalar form is encoded identically',
  )
  // Several free-text lines stay one custom answer, exactly as before.
  assert.deepEqual(
    await questionAnswer(h, [{ id: 'free', question: 'Anything else?' }], { answers: [['one', 'two']] }),
    { answers: [{ id: 'free', selected: [], custom: 'one\ntwo' }] },
    'multiple free-text entries are joined in order',
  )
  // Positive controls: option-bearing behaviour is unchanged.
  assert.deepEqual(
    await questionAnswer(h, [{
      id: 'pick', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }],
    }], { answers: [['A']] }),
    { answers: [{ id: 'pick', selected: ['A'] }] },
    'a declared label is still a selection',
  )
  assert.deepEqual(
    await questionAnswer(h, [{
      id: 'multi', question: 'Pick many', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }],
    }], { answers: [['A', 'B', 'extra note']] }),
    { answers: [{ id: 'multi', selected: ['A', 'B'], custom: 'extra note' }] },
    'a multiselect answer still splits labels from free text',
  )
  assert.deepEqual(
    await questionAnswer(h, [{
      id: 'plan-review',
      question: 'Approve this plan?',
      detail: 'plan body',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }], { answers: [['Approve']] }),
    { answers: [{ id: 'plan-review', selected: ['Approve'] }] },
    'the native plan-review approval rule still sees one label and no custom text',
  )
  assert.deepEqual(
    await questionAnswer(h, [{
      id: 'plan-review',
      question: 'Approve this plan?',
      detail: 'plan body',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }], { answers: [['tighten step 2']] }),
    { answers: [{ id: 'plan-review', selected: [], custom: 'tighten step 2' }] },
    'typed feedback on an option-bearing question stays native "keep planning" input',
  )
  await h.backend.close()
})