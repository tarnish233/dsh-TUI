import { strict as assert } from 'node:assert'
import test from 'node:test'
import type {
  BackendEvent,
  SessionEvent,
  SessionInfo,
  SubagentEntry,
  SubagentSnapshot,
  TodosSnapshot,
} from '../src/backend/types.ts'
import type { GoalStateView } from '../src/backend/native-inspection.ts'
import { DEMO_TRANSCRIPT_CODEC, DemoBackend } from '../src/demo.ts'
import { readNativeGoal } from '../src/native-ui.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { TranscriptItem } from '../src/state/transcript.ts'
import { activityGroupCounts, isPureStatusNotice, planActivityGroupNodes } from '../src/ui/activity-group.ts'
import { planTranscriptNodes } from '../src/ui/tool-group.ts'

/**
 * Source-level acceptance for the explicit offline `tasks` demo scene.
 *
 * The scene is fixture-only: it never starts an Agent, a timer or a playback
 * loop, and it reaches the goal dock only through the existing read-only
 * `native-goal` command plus `native_ui_changed(domain:'goal')` invalidation.
 * Parent-owned App/CLI/PTY rendering acceptance is intentionally not repeated
 * here.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface Session {
  readonly backend: DemoBackend
  readonly events: BackendEvent[]
}

async function start(delayMs = 0): Promise<Session> {
  const backend = new DemoBackend({ delayMs, cwd: '/tmp/demo-tasks' })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  await backend.connect()
  return { backend, events }
}

/** Run one explicit user turn and return only the events it produced. */
async function turn(session: Session, text: string): Promise<BackendEvent[]> {
  const from = session.events.length
  await session.backend.send(text)
  await session.backend.whenIdle()
  return session.events.slice(from)
}

const durableOf = (events: readonly BackendEvent[]): SessionEvent[] =>
  events.flatMap(event => (event.type === 'session_event' ? [event.event] : []))

const todoValues = (events: readonly BackendEvent[]): TodosSnapshot[] =>
  events.flatMap(event => (event.type === 'todos' ? [event.value] : []))

const lastTodos = (events: readonly BackendEvent[]): TodosSnapshot | undefined => todoValues(events).at(-1)

const subagentSnapshots = (events: readonly BackendEvent[]): SubagentSnapshot[] =>
  events.flatMap(event => (event.type === 'subagents' ? [event.value] : []))

const lastSubagents = (events: readonly BackendEvent[]): SubagentSnapshot | undefined => subagentSnapshots(events).at(-1)

const goalInvalidations = (events: readonly BackendEvent[]): number =>
  events.filter(event => event.type === 'native_ui_changed' && event.domain === 'goal').length

const assistantText = (events: readonly BackendEvent[]): string =>
  durableOf(events)
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => {
      const data = isRecord(event.data) && isRecord(event.data.message) ? event.data.message : {}
      return Array.isArray(data.content) ? data.content : []
    })
    .flatMap(part => (isRecord(part) && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')

const validPhases = new Set(['active', 'paused', 'blocked', 'complete'])

/** The fixture must return a real public GoalRead, never a private goal event. */
async function readGoal(backend: DemoBackend): Promise<GoalStateView | null> {
  const value = await backend.command('native-goal')
  const read = readNativeGoal(value)
  assert.ok(read !== undefined, 'native-goal must return the public GoalRead shape')
  assert.equal(read.available, true, 'the fixture goal read is always an available snapshot')
  if (read.available !== true) throw new Error('unreachable')
  assert.equal(read.complete, true)
  assert.equal(read.sessionId, backend.info.sessionId)
  return read.goal
}

function assertNativeGoal(goal: GoalStateView | null): asserts goal is GoalStateView {
  assert.ok(goal !== null, 'a loaded tasks scene has a native-shaped goal')
  assert.ok(validPhases.has(goal.phase), `phase "${goal.phase}" must use native vocabulary`)
  assert.ok(Number.isSafeInteger(goal.revision) && goal.revision > 0, 'revision is a positive integer')
  assert.ok(Number.isSafeInteger(goal.maxGoalRounds) && goal.maxGoalRounds > 0)
  assert.ok(goal.roundsStarted >= 0 && goal.roundsStarted <= goal.maxGoalRounds, 'rounds stay bounded')
  assert.ok(goal.objective.trim() !== '')
  if (goal.activation !== undefined) assert.ok(goal.activation === 'armed' || goal.activation === 'disarmed')
}

const TASK_CHILD_IDS = ['demo-child-active-1', 'demo-child-active-2', 'demo-child-active-3']
/** Existing fixture child that owns the mixed-activity sample (already finished). */
const TASK_SAMPLE_CHILD_ID = 'demo-child-test'

/**
 * `statuses` describes the three scripted children only.
 *
 * The snapshot additionally carries the completed sample sender, so total and
 * active counts are asserted separately instead of pretending the catalog has
 * three rows: the fixed Agents dock still reports exactly three active children.
 */
function assertTaskChildren(snapshot: SubagentSnapshot, statuses: readonly string[]): readonly SubagentEntry[] {
  assert.equal(statuses.length, 3, 'the scripted scene always has exactly three script children')
  assert.equal(snapshot.entries.length, 4, 'three script children plus the completed sample sender')
  const scripted = snapshot.entries.slice(0, 3)
  assert.deepEqual(scripted.map(entry => entry.id), TASK_CHILD_IDS)
  assert.deepEqual(scripted.map(entry => entry.status), statuses)
  for (const entry of scripted) {
    assert.equal(entry.local, true, `${entry.id} is a local child with a fixture session`)
    assert.equal(entry.mode, 'continuable', `${entry.id} stays continuable so /agent Reply keeps working`)
    assert.ok((entry.label ?? '').trim() !== '', `${entry.id} has a meaningful label`)
    // The fixture clock is not a real runtime clock: never hand production a
    // timing/token fact it would format against Date.now().
    assert.equal(entry.timing, undefined, `${entry.id} invents no runtime timing`)
    assert.equal(entry.totalTokens, undefined, `${entry.id} invents no token total`)
    if (entry.status === 'running' || entry.status === 'initializing') {
      assert.ok((entry.lastActivity ?? '').trim() !== '', `${entry.id} reports a real fixture activity`)
    } else {
      assert.equal(entry.lastActivity, undefined, `${entry.id} settled rows report no live activity`)
    }
  }
  const sample = snapshot.entries[3]
  assert.ok(sample !== undefined)
  assert.equal(sample.id, TASK_SAMPLE_CHILD_ID, 'the sample notice sender is a known existing fixture child')
  assert.equal(sample.status, 'completed', 'the sample sender was already finished, never a faked live completion')
  assert.equal(sample.lastStopReason, 'completed')
  assert.equal(sample.local, true, 'the catalog row stays inspectable through /agent')
  assert.equal(sample.parentSessionId, snapshot.entries[0]?.parentSessionId)
  assert.match(sample.label ?? '', /DEMO sample/, 'the sample row carries a clear sample label')
  assert.equal(sample.lastActivity, undefined)
  assert.equal(sample.timing, undefined, 'no runtime timing is invented for the sample')
  assert.equal(sample.totalTokens, undefined, 'no token total is invented for the sample')
  return snapshot.entries
}

const activeTaskChildren = (entries: readonly SubagentEntry[]): readonly SubagentEntry[] =>
  entries.filter(entry => entry.status === 'running' || entry.status === 'initializing')

interface AttributedMessage {
  readonly seq: number
  readonly id: string
  readonly source: Record<string, unknown>
  readonly content: readonly unknown[]
  readonly text: string
}

/** Every durable attributed `user/message` (settlement notice / agent relay). */
const attributedMessages = (events: readonly BackendEvent[]): AttributedMessage[] =>
  durableOf(events).flatMap(event => {
    if (event.type !== 'user/message' || !isRecord(event.data) || !isRecord(event.data.source)) return []
    const kind = event.data.source.kind
    if (kind !== 'subagent-settled' && kind !== 'agent-message') return []
    const content = Array.isArray(event.data.content) ? event.data.content : []
    return [{
      seq: event.seq,
      id: typeof event.data.id === 'string' ? event.data.id : '',
      source: event.data.source,
      content,
      text: content.flatMap(part => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n\n'),
    }]
  })

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Project the durable fixture events the way the app does.
 *
 * This proves the sample is genuinely eligible for the existing mixed-activity
 * projection instead of merely carrying plausible-looking fields.
 */
function projectActivity(
  events: readonly BackendEvent[],
  snapshot: SubagentSnapshot,
): { items: readonly TranscriptItem[]; nodes: ReturnType<typeof planActivityGroupNodes> } {
  const info: SessionInfo = {
    sessionId: 'demo-session-1',
    cwd: '/tmp/demo-tasks',
    provider: 'demo (offline)',
    model: 'deepseek-demo',
    capabilities: [],
    events: durableOf(events),
    subagents: snapshot,
  }
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info)
  const toolNodes = planTranscriptNodes(store.items, { groupTools: true, showThinking: false })
  return { items: store.items, nodes: planActivityGroupNodes(toolNodes, { groupActivities: true }) }
}

// ---------------------------------------------------------------------------
// Exact trigger parsing

test('tasks words are parsed exactly; prose, a bare next and unknown /commands never load the scene', async () => {
  for (const text of ['run tasks next', 'next', '/tasks', 'tasks next please', 'tasks unknown', 'task', 'tasks\nextra']) {
    const session = await start()
    try {
      const events = await turn(session, text)
      assert.equal(todoValues(events).length, 0, `"${text}" must not emit a Todo scene`)
      assert.equal(goalInvalidations(events), 0, `"${text}" must not invalidate the goal`)
      assert.equal(subagentSnapshots(events).length, 0, `"${text}" must not project fixture children`)
      assert.equal(await readGoal(session.backend), null, `"${text}" keeps native-goal empty`)
      await session.backend.close()
    } catch (error) {
      await session.backend.close()
      throw error
    }
  }
})

test('the control words are case-insensitive and advance deterministically', async () => {
  const session = await start()
  try {
    const initial = await turn(session, '  TASKS  ')
    assert.equal(todoValues(initial).length, 1)
    assertNativeGoal(await readGoal(session.backend))

    const next = await turn(session, 'TASKS NEXT')
    assert.equal(todoValues(next).length, 1)
    const goal = await readGoal(session.backend)
    assertNativeGoal(goal)
    assert.equal(goal.roundsStarted, 2)
    assert.equal(goal.phase, 'active')
  } finally {
    await session.backend.close()
  }
})

// ---------------------------------------------------------------------------
// Initial scene: three kinds coexist as live native-shaped facts

test('tasks paints ordered Todos, a native-shaped Goal and three local children at once', async () => {
  const session = await start()
  try {
    assert.ok(session.backend.info.capabilities.includes('native-goal'))
    const events = await turn(session, 'tasks')

    const todos = lastTodos(events)
    assert.ok(Array.isArray(todos))
    assert.equal(todos.length, 6, 'more than the five-row CC cap, so the overflow count is real')
    assert.deepEqual(todos.map(item => item.status), [
      'completed',
      'in_progress',
      'pending',
      'pending',
      'pending',
      'pending',
    ])
    assert.equal(new Set(todos.map(item => item.content)).size, 6, 'ordered, distinct native Todo items')

    const snapshot = lastSubagents(events)
    assert.ok(snapshot !== undefined)
    const children = assertTaskChildren(snapshot, ['running', 'initializing', 'running'])
    assert.equal(activeTaskChildren(children).length, 3, 'the fixed Agents dock still counts exactly three active children')
    assert.ok(children.some(entry => entry.label?.includes('Todo')), 'labels stay meaningful')
    assert.ok(children.some(entry => entry.label?.includes('Goal')))
    assert.ok(children.some(entry => entry.label?.includes('Agent')))
    for (const entry of children) assert.equal(entry.parentSessionId, session.backend.info.sessionId)

    // The goal is invalidated, never pushed as a private event; the existing
    // read-only command then serves the public GoalRead shape.
    assert.equal(goalInvalidations(events), 1)
    const goal = await readGoal(session.backend)
    assertNativeGoal(goal)
    assert.equal(goal.phase, 'active')
    assert.equal(goal.roundsStarted, 1)
    assert.equal(goal.maxGoalRounds, 6)
    assert.equal(goal.activation, 'armed')
    assert.match(goal.objective, /离线演示/)

    const text = assistantText(events)
    assert.match(text, /fixture-only/)
    assert.match(text, /不调用模型/)
    assert.match(text, /Ctrl\+T/)
    assert.match(text, /native-goal/)
    assert.match(text, /tasks next/)
    assert.match(text, /tasks done/)
    assert.match(text, /tasks history/)
    assert.match(text, /tasks clear/)

    // The explanation arrives line/phrase-batched, not one grapheme at a time,
    // so the static scene settles quickly at the default demo delay.
    const deltas = events.flatMap(event =>
      event.type === 'stream_chunk' && event.chunk.type === 'text-delta' && typeof event.chunk.text === 'string'
        ? [event.chunk.text] : [])
    assert.ok(deltas.length > 0 && deltas.length <= 12, `batched explanation, got ${deltas.length} text chunks`)
    assert.equal(deltas.join(''), text)

    // Live stream settlement is the existing committed path; the scene itself
    // is durable projection data and no decision/Agent work appears.
    assert.ok(events.some(event => event.type === 'stream_end' && event.outcome === 'committed'))
    assert.equal(events.some(event => event.type === 'decision'), false)

    // After the root settles the static scene must remain inspectable.
    assert.equal(session.backend.busy, false)
    assert.equal(session.backend.info.subagents?.entries.length, 4, 'three active children plus the completed sample sender')
    const before = session.events.length
    await delay(20)
    assert.equal(session.events.length, before, 'no autonomous fixture timer or playback loop')
    const reread = await readGoal(session.backend)
    assertNativeGoal(reread)
    assert.equal(reread.phase, 'active')
  } finally {
    await session.backend.close()
  }
})

// ---------------------------------------------------------------------------
// Mixed activity sample: one fixture tool + one pure notice + one real relay

test('the initial scene carries one fixture tool/result, one pure notice and one relay in native order', async () => {
  const session = await start()
  try {
    const events = await turn(session, 'tasks')
    const durable = durableOf(events)
    const snapshot = lastSubagents(events)
    assert.ok(snapshot !== undefined)
    assertTaskChildren(snapshot, ['running', 'initializing', 'running'])

    // Exactly one real admission and one settlement: the sample never writes a
    // duplicate or a second proposed call to explain the same tool.
    const calls = durable.filter(event => event.type === 'tool/call')
    const results = durable.filter(event => event.type === 'tool/result')
    assert.equal(calls.length, 1, 'one real fixture tool call')
    assert.equal(results.length, 1, 'one real fixture tool result')
    const call = calls[0]!
    assert.ok(isRecord(call.data))
    assert.equal(call.data.name, 'list_agents', 'the fixture tool is the native child-list read')
    assert.equal(call.data.arguments, '{"mode":"children"}')
    assert.deepEqual(Object.keys(call.data).sort(), ['arguments', 'callId', 'name', 'step', 'turn'], 'no metric fields are invented')
    const result = results[0]!
    assert.ok(isRecord(result.data) && isRecord(result.data.message))
    assert.equal(result.data.message.toolCallId, call.data.callId, 'the result settles the same call id')
    assert.equal(result.data.message.isError, false)
    assert.equal(Object.hasOwn(result.data, 'usage'), false, 'the fixture result carries no usage metrics')
    const resultText = Array.isArray(result.data.message.content)
      ? result.data.message.content.flatMap(part => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n')
      : ''
    assert.equal(resultText.split('\n').length, 4, 'a few text lines of child catalog')
    assert.match(resultText, /demo-child-active-1/)
    assert.match(resultText, new RegExp(TASK_SAMPLE_CHILD_ID))
    // No assistant message claims a second tool call for the sample.
    for (const message of durable.filter(event => event.type === 'assistant/message')) {
      const content = isRecord(message.data) && isRecord(message.data.message) && Array.isArray(message.data.message.content)
        ? message.data.message.content
        : []
      assert.equal(content.some(part => isRecord(part) && part.type === 'tool-call'), false, 'no duplicate fake call proposes the fixture tool')
    }

    // One pure `subagent-settled`/`notice` and one real `agent-message`/`relay`.
    const messages = attributedMessages(events)
    assert.equal(messages.length, 2, 'exactly one settlement notice and one relay')
    const notice = messages[0]!
    const relay = messages[1]!
    assert.equal(notice.source.kind, 'subagent-settled')
    assert.equal(notice.source.form, 'notice', 'the notice keeps the native form the projection gates on')
    assert.equal(notice.source.senderSessionId, TASK_SAMPLE_CHILD_ID, 'attributed to the already-finished fixture child')
    assert.equal(typeof notice.source.summary, 'string')
    assert.match(notice.text, /^Sample settlement:/)
    assert.match(notice.text, /DEMO STATUS NOTICE BODY/, 'the expand-only body marker survives verbatim')
    assert.equal(Object.hasOwn(notice.source, 'usage'), false)
    assert.equal(Object.hasOwn(notice.source, 'timing'), false)
    assert.equal(relay.source.kind, 'agent-message')
    assert.equal(relay.source.form, 'relay')
    assert.equal(relay.source.senderSessionId, TASK_SAMPLE_CHILD_ID)
    assert.match(relay.text, /^Agent demo-child-test sent a message: /, 'the native relay prefix is kept')
    assert.match(relay.text, /DEMO CHILD MESSAGE/, 'the independent child-message marker is kept verbatim')
    assert.match(relay.text, /Ctrl\+O/, 'the relay body carries the disclosure hint')
    assert.match(relay.text, /tasks next/, 'the relay body carries the next control word')

    // Native declared order: call, result, notice, relay, then the turn end.
    const at = (event: SessionEvent | undefined): number => (event === undefined ? -1 : durable.indexOf(event))
    const callIndex = at(call)
    const resultIndex = at(result)
    const noticeEvent = durable.find(event => event.seq === notice.seq)
    const relayEvent = durable.find(event => event.seq === relay.seq)
    assert.equal(resultIndex, callIndex + 1, 'the result immediately follows its call')
    assert.equal(at(noticeEvent), resultIndex + 1, 'the notice immediately follows the result')
    assert.equal(at(relayEvent), at(noticeEvent) + 1, 'the relay is the next durable fact')
    assert.equal(durable.at(-1)?.type, 'turn/end')
    assert.ok(notice.seq < relay.seq)

    // The attributed sender stays a known catalog row, so /agent can inspect it
    // while the fixed Agents dock keeps counting exactly the three active rows.
    const senders = snapshot.entries.filter(entry => entry.id === TASK_SAMPLE_CHILD_ID)
    assert.equal(senders.length, 1)
    assert.equal(senders[0]?.status, 'completed')
    assert.equal(activeTaskChildren(snapshot.entries).length, 3)
    const childSession = await session.backend.command('subagent-session', { sessionId: TASK_SAMPLE_CHILD_ID }) as {
      sessionId: string
      events: SessionEvent[]
    }
    assert.equal(childSession.sessionId, TASK_SAMPLE_CHILD_ID)
    assert.ok(childSession.events.some(event => event.type === 'assistant/message'))
  } finally {
    await session.backend.close()
  }
})

test('the sample is one real mixed activity group and the relay stays a message boundary', async () => {
  const session = await start()
  try {
    const events = await turn(session, 'tasks')
    const snapshot = lastSubagents(events)
    assert.ok(snapshot !== undefined)
    const { items, nodes } = projectActivity(events, snapshot)

    // No duplicate or fabricated tool: the store holds exactly the one call.
    const tools = items.filter(item => item.kind === 'tool')
    assert.equal(tools.length, 1, 'the projection holds exactly one real tool item')
    const tool = tools[0]
    assert.ok(tool !== undefined && tool.kind === 'tool')
    assert.equal(tool.name, 'list_agents')
    assert.equal(tool.status, 'done')

    const mixed = nodes.filter(node => node.kind === 'activity-group')
    assert.equal(mixed.length, 1, 'exactly one mixed activity group')
    const group = mixed[0]!
    assert.equal(group.kind, 'activity-group')
    if (group.kind !== 'activity-group') throw new Error('unreachable mixed activity group')
    assert.equal(group.anchor.id, 'tool:demo-tasks-call-1', 'anchored on the real call')
    assert.deepEqual(group.members.map(member => member.kind), ['tool', 'subagent-message'])
    const noticeMember = group.members[1]!
    assert.ok(isPureStatusNotice(noticeMember), 'the second member is the native pure notice')
    assert.equal(noticeMember.senderSessionId, TASK_SAMPLE_CHILD_ID)
    assert.equal(noticeMember.form, 'notice')
    assert.equal(noticeMember.sourceKind, 'subagent-settled')
    assert.match(noticeMember.text, /DEMO STATUS NOTICE BODY/, 'the raw notice text is preserved, not rewritten')
    const counts = activityGroupCounts(group.members)
    assert.equal(counts.tools, 1, 'one real tool')
    assert.equal(counts.updates, 1, 'one pure notice')
    assert.equal(counts.running + counts.proposed + counts.failed + counts.unknown, 0, 'nothing is left running or unresolved')

    // A genuine `agent-message` relay is the very next node: it is a real
    // message boundary, never a member of the tools/status group.
    const groupIndex = nodes.findIndex(node => node === group)
    const next = nodes[groupIndex + 1]
    assert.ok(next !== undefined)
    assert.equal(next.kind, 'item')
    assert.ok(next.kind === 'item')
    assert.equal(next.item.kind, 'subagent-message')
    assert.equal(next.item.kind === 'subagent-message' ? next.item.sourceKind : '', 'agent-message')
    assert.equal(next.item.kind === 'subagent-message' ? next.item.form : '', 'relay')
    assert.equal(isPureStatusNotice(next.item), false, 'the relay is never eligible as a status update')
    assert.equal(nodes.filter(node => node.kind === 'activity-group').length, 1, 'no duplicate mixed group is invented')
  } finally {
    await session.backend.close()
  }
})

test('repeated tasks restarts keep every sample id unique and never emit the sample elsewhere', async () => {
  const session = await start()
  try {
    const callIds: string[] = []
    const ids: string[] = []
    const collect = (events: readonly BackendEvent[]): void => {
      for (const event of durableOf(events)) {
        if (event.type === 'tool/call' && isRecord(event.data) && typeof event.data.callId === 'string') callIds.push(event.data.callId)
        if (event.type === 'tool/result' && isRecord(event.data) && isRecord(event.data.message) && typeof event.data.message.id === 'string') ids.push(event.data.message.id)
      }
      for (const message of attributedMessages(events)) ids.push(message.id)
    }

    const first = await turn(session, 'tasks')
    collect(first)
    const stepOne = await turn(session, 'tasks next')
    collect(stepOne)
    assert.equal(durableOf(stepOne).some(event => event.type === 'tool/call'), false, 'next never re-emits the sample tool')
    assert.equal(attributedMessages(stepOne).length, 0, 'next never re-emits the sample notice/relay')
    collect(await turn(session, 'tasks'))
    collect(await turn(session, 'tasks done'))
    collect(await turn(session, 'tasks'))

    assert.deepEqual(callIds, ['demo-tasks-call-1', 'demo-tasks-call-3', 'demo-tasks-call-5'], 'one turn-scoped call per restart')
    assert.equal(new Set(callIds).size, callIds.length, 'restarts never reuse a call id')
    assert.equal(ids.length, 9, 'each restart keeps its own result, notice and relay ids')
    assert.equal(new Set(ids).size, ids.length, 'no later restart overwrites an earlier sample fact')
    assert.ok(ids.every(id => id !== ''))

    // Every sample fact is durable: the log, not the projection, owns them.
    const allDurable = durableOf(session.events)
    assert.equal(allDurable.filter(event => event.type === 'tool/call').length, 3)
    assert.equal(allDurable.filter(event => event.type === 'tool/result').length, 3)
    assert.equal(attributedMessages(session.events).length, 6)
  } finally {
    await session.backend.close()
  }
})

test('the completed sample sender persists through stages and clear retires it', async () => {
  const session = await start()
  try {
    await turn(session, 'tasks')
    const stepped = await turn(session, 'tasks next')
    const steppedSnapshot = lastSubagents(stepped)
    assert.ok(steppedSnapshot !== undefined)
    assertTaskChildren(steppedSnapshot, ['completed', 'running', 'running'])
    assert.equal(activeTaskChildren(steppedSnapshot.entries).length, 2, 'only the scripted children are live')
    assert.equal(steppedSnapshot.entries[3]?.label, 'Focused tests · DEMO sample', 'the attribution stays known across stages')

    const done = await turn(session, 'tasks done')
    const doneSnapshot = lastSubagents(done)
    assert.ok(doneSnapshot !== undefined)
    assert.equal(doneSnapshot.entries.length, 4)
    assert.equal(doneSnapshot.entries[3]?.status, 'completed', 'done never re-completes or drops the sample row')
    assert.equal(activeTaskChildren(doneSnapshot.entries).length, 0)

    const cleared = await turn(session, 'tasks clear')
    assert.deepEqual(lastSubagents(cleared)?.entries, [], 'clear retires the whole catalog, sample row included')
    assert.equal(session.backend.info.subagents?.entries.length, 0)
  } finally {
    await session.backend.close()
  }
})

// ---------------------------------------------------------------------------
// Explicit finite script: next / done / restart / clear / history

test('next advances Todo status, Goal rounds/phase and child settlement; done/restart/clear stay deterministic', async () => {
  const session = await start()
  try {
    const initial = await turn(session, 'tasks')
    const initialSnapshot = lastSubagents(initial)
    assert.ok(initialSnapshot !== undefined)
    const initialActivities = new Map(initialSnapshot.entries.map(entry => [entry.id, entry.lastActivity]))
    const initialGoal = await readGoal(session.backend)
    assertNativeGoal(initialGoal)

    // Step 1: Todo completion/status update + Goal round + child settlement/activity.
    const stepOne = await turn(session, 'tasks next')
    const todosOne = lastTodos(stepOne)
    assert.ok(Array.isArray(todosOne))
    assert.deepEqual(todosOne.map(item => item.status), [
      'completed',
      'completed',
      'in_progress',
      'pending',
      'pending',
      'pending',
    ])
    const goalOne = await readGoal(session.backend)
    assertNativeGoal(goalOne)
    assert.equal(goalOne.phase, 'active')
    assert.equal(goalOne.roundsStarted, 2)
    assert.equal(goalOne.revision, 2)
    const snapshotOne = lastSubagents(stepOne)
    assert.ok(snapshotOne !== undefined)
    assertTaskChildren(snapshotOne, ['completed', 'running', 'running'])
    assert.equal(snapshotOne.entries[0]?.lastActivity, undefined, 'a settled child reports no live activity')
    assert.notEqual(snapshotOne.entries[1]?.lastActivity, initialActivities.get('demo-child-active-2'))
    assert.notEqual(snapshotOne.entries[2]?.lastActivity, initialActivities.get('demo-child-active-3'))

    // Step 2: another Todo progress + native paused phase + second settlement.
    const stepTwo = await turn(session, 'tasks next')
    const todosTwo = lastTodos(stepTwo)
    assert.ok(Array.isArray(todosTwo))
    assert.deepEqual(todosTwo.map(item => item.status), [
      'completed',
      'completed',
      'completed',
      'completed',
      'in_progress',
      'pending',
    ])
    const goalTwo = await readGoal(session.backend)
    assertNativeGoal(goalTwo)
    assert.equal(goalTwo.phase, 'paused')
    assert.equal(goalTwo.roundsStarted, 2)
    assert.equal(goalTwo.revision, 3)
    assert.equal(goalTwo.activation, 'disarmed')
    const snapshotTwo = lastSubagents(stepTwo)
    assert.ok(snapshotTwo !== undefined)
    assertTaskChildren(snapshotTwo, ['completed', 'completed', 'running'])
    assert.notEqual(snapshotTwo.entries[2]?.lastActivity, snapshotOne.entries[2]?.lastActivity)

    // A third next is bounded: no new projection changes, only an explanation.
    const stepThree = await turn(session, 'tasks next')
    assert.equal(todoValues(stepThree).length, 0)
    assert.equal(subagentSnapshots(stepThree).length, 0)
    assert.equal(goalInvalidations(stepThree), 0)
    assert.match(assistantText(stepThree), /最后一步/)
    assert.equal((await readGoal(session.backend))?.phase, 'paused')

    // done completes the list, keeps a valid completed goal and retires actives.
    const done = await turn(session, 'tasks done')
    const doneTodos = lastTodos(done)
    assert.ok(Array.isArray(doneTodos))
    assert.equal(doneTodos.length, 6)
    assert.ok(doneTodos.every(item => item.status === 'completed'), 'the whole list is completed')
    const doneGoal = await readGoal(session.backend)
    assertNativeGoal(doneGoal)
    assert.equal(doneGoal.phase, 'complete')
    assert.equal(doneGoal.roundsStarted, 2)
    const doneSnapshot = lastSubagents(done)
    assert.ok(doneSnapshot !== undefined)
    assert.equal(doneSnapshot.entries.length, 4, 'three script children plus the completed sample sender')
    assert.ok(doneSnapshot.entries.every(entry => entry.status !== 'running' && entry.status !== 'initializing'))
    assert.equal(doneSnapshot.entries[2]?.status, 'completed', 'the success-ending script completes its live child')
    assert.equal(doneSnapshot.entries[2]?.lastStopReason, 'completed')
    assert.ok(doneSnapshot.entries.every(entry => entry.timing === undefined && entry.totalTokens === undefined))

    // `tasks` restarts the same fixture from the initial stage.
    const restarted = await turn(session, 'tasks')
    const restartedTodos = lastTodos(restarted)
    assert.ok(Array.isArray(restartedTodos))
    assert.deepEqual(restartedTodos.map(item => item.status), [
      'completed',
      'in_progress',
      'pending',
      'pending',
      'pending',
      'pending',
    ])
    const restartedGoal = await readGoal(session.backend)
    assertNativeGoal(restartedGoal)
    assert.equal(restartedGoal.phase, 'active')
    assert.equal(restartedGoal.roundsStarted, 1)
    assert.equal(restartedGoal.revision, 1)
    const restartedSnapshot = lastSubagents(restarted)
    assert.ok(restartedSnapshot !== undefined)
    assertTaskChildren(restartedSnapshot, ['running', 'initializing', 'running'])

    // history adds a bounded transcript but preserves the whole scene.
    const historyOne = await turn(session, 'tasks history')
    const historyUsers = durableOf(historyOne).filter(event => event.type === 'user/message').length
    const historyAssistants = durableOf(historyOne).filter(event => event.type === 'assistant/message').length
    assert.ok(historyUsers >= 20 && historyUsers <= 30, `bounded history, got ${historyUsers} user messages`)
    assert.ok(historyAssistants >= 20 && historyAssistants <= 30, `bounded history, got ${historyAssistants} assistants`)
    assert.equal(historyUsers, historyAssistants)
    assert.match(assistantText(historyOne), /长 fixture transcript/)
    assert.equal(todoValues(historyOne).length, 0, 'history emits no Todo replacement')
    assert.equal(subagentSnapshots(historyOne).length, 0, 'history emits no child replacement')
    const historyGoal = await readGoal(session.backend)
    assertNativeGoal(historyGoal)
    assert.equal(historyGoal.revision, restartedGoal.revision)
    assert.deepEqual(session.backend.info.subagents, restartedSnapshot)

    const historyTwo = await turn(session, 'tasks history')
    const secondUsers = durableOf(historyTwo).filter(event => event.type === 'user/message').length
    assert.equal(secondUsers, historyUsers, 'each bounded history emission is the same finite size')
    assert.deepEqual(session.backend.info.subagents, restartedSnapshot, 'repeated history never mutates the scene')

    // clear removes all three projections and the read becomes a real empty goal.
    const cleared = await turn(session, 'tasks clear')
    assert.deepEqual(todoValues(cleared), [null])
    const clearedSnapshot = lastSubagents(cleared)
    assert.ok(clearedSnapshot !== undefined)
    assert.deepEqual(clearedSnapshot.entries, [])
    assert.equal(goalInvalidations(cleared), 1)
    assert.equal(await readGoal(session.backend), null)
    assert.deepEqual(session.backend.info.subagents, { entries: [] })
    assert.match(assistantText(cleared), /已清理/)

    // A new explicit next after clear deterministically restarts then advances.
    const afterClear = await turn(session, 'tasks next')
    const afterClearTodos = lastTodos(afterClear)
    assert.ok(Array.isArray(afterClearTodos))
    assert.deepEqual(afterClearTodos.map(item => item.status), [
      'completed',
      'completed',
      'in_progress',
      'pending',
      'pending',
      'pending',
    ])
    assert.equal((await readGoal(session.backend))?.roundsStarted, 2)
  } finally {
    await session.backend.close()
  }
})

// ---------------------------------------------------------------------------
// Child controls keep using the existing /agent paths

test('task children remain addressable through subagent-session, Stop and Reply', async () => {
  const session = await start()
  try {
    await turn(session, 'tasks')

    const child = await session.backend.command('subagent-session', { sessionId: 'demo-child-active-1' }) as {
      sessionId: string
      events: SessionEvent[]
    }
    assert.equal(child.sessionId, 'demo-child-active-1')
    assert.ok(child.events.some(event => event.type === 'assistant/message'))

    const stopped = await session.backend.command('subagent-interrupt', { sessionId: 'demo-child-active-1' }) as {
      accepted: boolean
      stopped: boolean
      status: string
    }
    assert.equal(stopped.accepted, true)
    assert.equal(stopped.stopped, true)
    assert.equal(stopped.status, 'stopped')

    const reply = await session.backend.command('subagent-prompt', {
      sessionId: 'demo-child-active-2',
      text: '继续检查 Goal 停靠区',
    }) as { sessionId: string; runId: string; demo: boolean }
    assert.equal(reply.sessionId, 'demo-child-active-2')
    assert.equal(reply.demo, true)
    await delay(0)
    const after = session.backend.info.subagents?.entries.find(entry => entry.id === 'demo-child-active-2')
    assert.equal(after?.status, 'idle', 'the existing follow-up completion settles the fixture child')
  } finally {
    await session.backend.close()
  }
})

// ---------------------------------------------------------------------------
// New / resume / close / cancel must not leak or emit late fixture events

test('new and resume clear the task fixture state and never leak old projections', async () => {
  const session = await start()
  try {
    await turn(session, 'tasks')
    assertNativeGoal(await readGoal(session.backend))

    const beforeNew = session.events.length
    await session.backend.command('new')
    const afterNew = session.events.slice(beforeNew)
    assert.equal(todoValues(afterNew).length, 0, 'a fresh root emits no old Todo projection')
    assert.equal(subagentSnapshots(afterNew).length, 0, 'a fresh root emits no old child catalog')
    assert.equal(goalInvalidations(afterNew), 0)
    assert.equal(await readGoal(session.backend), null)
    assert.equal(session.backend.info.subagents, undefined)
    await assert.rejects(
      session.backend.command('subagent-interrupt', { sessionId: 'demo-child-active-1' }),
      /No demo child session/,
    )

    await turn(session, 'tasks')
    const beforeResume = session.events.length
    await session.backend.command('resume', { sessionId: 'demo-resumed-root' })
    const afterResume = session.events.slice(beforeResume)
    assert.equal(todoValues(afterResume).length, 0)
    assert.equal(subagentSnapshots(afterResume).length, 0)
    assert.equal(goalInvalidations(afterResume), 0)
    assert.equal(await readGoal(session.backend), null)
    assert.equal(session.backend.info.subagents, undefined)
    await assert.rejects(
      session.backend.command('subagent-prompt', { sessionId: 'demo-child-active-1', text: 'hi' }),
      /No demo child session/,
    )

    // The next explicit tasks turn belongs to the resumed root only.
    const fresh = await turn(session, 'tasks')
    const snapshot = lastSubagents(fresh)
    assert.ok(snapshot !== undefined)
    assert.equal(snapshot.entries.length, 4)
    for (const entry of snapshot.entries) assert.equal(entry.parentSessionId, 'demo-resumed-root')
    assert.equal(snapshot.entries.some(entry => entry.id === TASK_SAMPLE_CHILD_ID), true, 'the sample sender is re-projected for the resumed root')
    assert.equal((await readGoal(session.backend))?.id, 'demo-task-goal')
  } finally {
    await session.backend.close()
  }
})

test('cancel mid-scene follows existing abandoned-stream semantics with no late child events', async () => {
  const session = await start(5)
  try {
    let abandoned = 0
    let assistant = 0
    session.backend.onEvent(event => {
      if (event.type === 'stream_end' && event.outcome === 'abandoned') abandoned += 1
      if (event.type === 'session_event' && event.event.type === 'assistant/message') assistant += 1
    })
    const chunk = new Promise<void>(resolve => {
      const off = session.backend.onEvent(event => {
        if (event.type === 'stream_chunk') {
          off()
          resolve()
        }
      })
    })
    await session.backend.send('tasks')
    await chunk
    // The scene projections are already durable facts when the stream is cancelled.
    assert.equal(session.backend.info.subagents?.entries.length, 4, 'three active children plus the completed sample sender')
    assertNativeGoal(await readGoal(session.backend))
    await session.backend.cancel()
    await session.backend.whenIdle()
    assert.equal(session.backend.busy, false)
    assert.ok(abandoned >= 1, 'the tentative stream is abandoned, not committed')
    assert.equal(assistant, 0, 'no reply is fabricated after cancellation')
    const frozen = JSON.stringify(session.backend.info.subagents)
    await delay(20)
    assert.equal(JSON.stringify(session.backend.info.subagents), frozen, 'no late fixture child settlement')
  } finally {
    await session.backend.close()
  }
})

test('close during the scene stream emits no fixture events afterwards', async () => {
  const session = await start(5)
  try {
    const chunk = new Promise<void>(resolve => {
      const off = session.backend.onEvent(event => {
        if (event.type === 'stream_chunk') {
          off()
          resolve()
        }
      })
    })
    await session.backend.send('tasks')
    await chunk
    await session.backend.close()
    const closedAt = session.events.length
    assert.equal(session.events.at(-1)?.type, 'closed')
    await assert.rejects(session.backend.send('tasks'), /closed/)
    await delay(25)
    assert.equal(session.events.length, closedAt, 'no stream/subagent/goal events after close')
    assert.equal(session.events.at(-1)?.type, 'closed')
  } finally {
    await session.backend.close()
  }
})

// ---------------------------------------------------------------------------
// Existing demo scenarios keep their own paths

test('legacy tools/subagent/skills/ordinary prompts are unaffected and keep native-goal empty', async () => {
  const session = await start()
  try {
    const tools = await turn(session, 'tools')
    assert.ok(durableOf(tools).some(event => event.type === 'tool/call' && isRecord(event.data) && event.data.name === 'bash'))
    assert.equal(todoValues(tools).length, 0)
    assert.equal(goalInvalidations(tools), 0)
    assert.equal(await readGoal(session.backend), null)

    const subagent = await turn(session, 'subagent')
    const snapshot = lastSubagents(subagent)
    assert.ok(snapshot !== undefined)
    const ids = snapshot.entries.map(entry => entry.id)
    assert.ok(ids.includes('demo-child-explore'), 'the legacy child fixture still runs')
    assert.ok(!ids.some(id => TASK_CHILD_IDS.includes(id)), 'the task scene children are not mixed in')
    assert.equal(todoValues(subagent).length, 0)
    assert.equal(goalInvalidations(subagent), 0)
    assert.equal(await readGoal(session.backend), null)

    const skills = await turn(session, 'skills')
    assert.match(assistantText(skills), /Offline skill fixture/)
    assert.equal(todoValues(skills).length, 0)
    assert.equal(goalInvalidations(skills), 0)

    const ordinary = await turn(session, 'hello from the demo')
    assert.ok(assistantText(ordinary).length > 0)
    assert.equal(todoValues(ordinary).length, 0)
    assert.equal(subagentSnapshots(ordinary).length, 0)
    assert.equal(await readGoal(session.backend), null)
  } finally {
    await session.backend.close()
  }
})