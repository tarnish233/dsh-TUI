import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { BackendEvent, SessionEvent, SkillCatalogSnapshot } from '../src/backend/types.ts'
import { DEMO_COMMANDS, DEMO_SKILLS, DEMO_SKILL_CATALOG, DemoBackend } from '../src/demo.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sessionEvents = (events: readonly BackendEvent[]): SessionEvent[] =>
  events.flatMap(event => (event.type === 'session_event' ? [event.event] : []))

/** Same wiring the app uses, minus the transcript store. */
async function pump(text: string): Promise<{ events: BackendEvent[]; backend: DemoBackend }> {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  await backend.connect()
  await backend.send(text)
  await backend.whenIdle()
  return { events, backend }
}

const assistantText = (events: readonly SessionEvent[]): string =>
  events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => {
      const data = isRecord(event.data) && isRecord(event.data.message) ? event.data.message : {}
      return Array.isArray(data.content) ? data.content : []
    })
    .flatMap(part => (isRecord(part) && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')

// ---------------------------------------------------------------------------
// Frozen metadata contract

test('command("skills") serves a frozen, native-shaped SkillCatalogSnapshot', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const info = await backend.connect()
  // Honest fixture advertisement: the parent capability-gates command('skills')
  // on the mounted-native capability list, and this demo implements that query.
  assert.ok(info.capabilities.includes('skills'))
  const value = await backend.command('skills')
  assert.ok(isRecord(value))
  const snapshot = value as unknown as SkillCatalogSnapshot
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.complete, true)
  assert.ok(Array.isArray(snapshot.entries))
  assert.ok(snapshot.entries.length >= 3, 'the fixture carries several native-shaped entries')
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.entries))

  for (const entry of snapshot.entries) {
    assert.ok(Object.isFrozen(entry))
    assert.equal(typeof entry.name, 'string')
    assert.match(entry.name, /^[a-z][a-z0-9-]*$/, 'native identifier, no / or skill: prefix')
    assert.equal(typeof entry.description, 'string')
    assert.ok(entry.description.trim() !== '')
    assert.equal(typeof entry.modelInvocable, 'boolean')
    if (entry.whenToUse !== undefined) assert.equal(typeof entry.whenToUse, 'string')
    // Metadata only: no skill body, path, injection payload or tool plan.
    const extra = Object.keys(entry).filter(key => !['name', 'description', 'whenToUse', 'modelInvocable'].includes(key))
    assert.deepEqual(extra, [], `skill entry carries only display metadata, got ${extra.join(',')}`)
  }

  // A previous snapshot cannot be mutated into a second catalog.
  const entries = snapshot.entries as unknown as { name: string }[]
  assert.throws(() => { entries[0]!.name = 'rewritten' }, TypeError)
  assert.equal(snapshot.entries[0]?.name, DEMO_SKILLS[0]?.name)
  await backend.close()
})

test('the fixture includes ordinary, user-only and mounted-native-command names', () => {
  const modelInvocable = DEMO_SKILLS.filter(entry => entry.modelInvocable)
  const userOnly = DEMO_SKILLS.filter(entry => entry.modelInvocable === false)
  assert.ok(modelInvocable.length >= 1)
  assert.ok(userOnly.length >= 1, 'a user-only entry must exist for the /help marker')
  assert.ok(userOnly.every(entry => entry.description.trim() !== ''))

  const nativeNames = new Set(DEMO_COMMANDS.map(command => command.name))
  const collision = DEMO_SKILLS.filter(entry => nativeNames.has(entry.name))
  assert.equal(collision.length, 1, 'exactly one fixture skill reuses a mounted native command name')
  assert.equal(collision[0]?.name, 'compact')

  assert.equal(DEMO_SKILL_CATALOG.entries, DEMO_SKILLS)
})

test('every query returns the same deterministic fixture, with no body or execution stand-in', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  await backend.connect()
  const first = await backend.command('skills')
  const second = await backend.command('skills')
  assert.equal(first, DEMO_SKILL_CATALOG)
  assert.equal(second, DEMO_SKILL_CATALOG)
  const serialized = JSON.stringify(first)
  for (const forbidden of ['body', 'content', 'path', 'injection', 'script', 'tools']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `the fixture must not invent a ${forbidden} field`)
  }
  await backend.close()
})

// ---------------------------------------------------------------------------
// `--demo skills` wire contract

test('the explicit `skills` scenario streams a metadata-only acknowledgement', async () => {
  const { backend, events } = await pump('skills')
  const wire = events.filter(event => event.type !== 'status' && event.type !== 'ready')
  assert.ok(wire.length > 0)

  // Live frames are strictly increasing and every surface event keeps append origin.
  const revisions: number[] = []
  for (const event of events) {
    if (event.type === 'stream_start' || event.type === 'stream_chunk' || event.type === 'stream_end') {
      revisions.push(event.revision)
    }
  }
  assert.ok(revisions.length >= 4)
  for (let index = 1; index < revisions.length; index += 1) {
    assert.ok(revisions[index]! > revisions[index - 1]!, 'revisions must strictly increase')
  }

  const durable = sessionEvents(events)
  const user = durable.find(event => event.type === 'user/message')
  assert.ok(user, 'the scenario begins with a durable user message')
  const reply = assistantText(durable)
  assert.match(reply, /Offline skill fixture/)
  assert.match(reply, /no skill body was read/)
  assert.match(reply, /no tool or model ran/)
  for (const name of DEMO_SKILLS.map(entry => '/' + entry.name)) assert.ok(reply.includes(name))
  assert.match(reply, /display-only Skills section/)

  // No decision, no tool call, no fabricated skill execution.
  assert.ok(!events.some(event => event.type === 'decision'))
  assert.ok(!durable.some(event => event.type === 'tool/call' || event.type === 'tool/result'))
  const message = durable.find(event => event.type === 'assistant/message')
  assert.equal(message?.surfaceOp, 'append')
  await backend.close()
})

test('a fixture /name is acknowledged as an ordinary user message, not an injected skill', async () => {
  const { backend, events } = await pump('/code-review please')
  const durable = sessionEvents(events)
  const reply = assistantText(durable)
  assert.match(reply, /Offline skill fixture/)
  assert.match(reply, /`\/code-review` arrived as an ordinary user message/)
  assert.match(reply, /the demo has no skill body and injects nothing/)
  assert.match(reply, /DSH owns skill resolution and pre-step injection/)
  assert.ok(!durable.some(event => event.type === 'tool/call'), 'no tool work is simulated')
  await backend.close()
})

test('the colliding fixture /name is routed by the parent, and the demo still acknowledges it offline', async () => {
  const { backend, events } = await pump('/compact')
  const reply = assistantText(sessionEvents(events))
  assert.match(reply, /`\/compact` arrived as an ordinary user message/)
  // Native command execution keeps its own semantics.
  const executed = await backend.command('execute', { line: '/compact' })
  assert.equal((executed as { result: { kind: string } }).result.kind, 'success')
  await backend.close()
})

test('the skills fixture never changes ordinary demo paths or native command execution', async () => {
  // A plain message still runs the historical default tool flow.
  const { backend, events } = await pump('hello demo')
  const durable = sessionEvents(events)
  assert.ok(durable.some(event => event.type === 'tool/call'), 'the default fixture still runs its tool flow')
  assert.doesNotMatch(assistantText(durable), /Offline skill fixture/)

  // Mounted commands still resolve through the native execute path only.
  const status = await backend.command('execute', { line: '/status' })
  assert.equal((status as { result: { kind: string } }).result.kind, 'success')
  const unknown = await backend.command('execute', { line: '/code-review' }) as { result: { kind: string } }
  assert.equal(unknown.result.kind, 'error', 'skills are /name user messages, never a management command')
  await backend.close()
})