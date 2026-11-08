// Offline matrix for the renderer-owned terminal presentation controller.
// No PTY, no native backend, no model/profile, no Rex/Ghostty process: the
// terminal seam is a recording fake and the OSC writers are captured arrays.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import type {
  BackendEvent,
  DecisionRequest,
  SessionEvent,
  SessionInfo,
  SubagentEntry,
  SubagentStatus,
} from '../src/backend/types.ts'
import {
  classifyTurnEnd,
  detectTerminalFamily,
  MAX_CHILD_RECORDS,
  TERMINAL_APP_ID,
  TerminalIntegration,
  terminalChildRecordId,
  terminalEnvironment,
  terminalFileUrl,
  type TerminalEnvironment,
  type TerminalIntegrationSettings,
  type TerminalIntegrationTerminal,
  type TerminalPresentationSnapshot,
  type TerminalProgramStatus,
} from '../src/ui/terminal-integration.ts'

// ---------------------------------------------------------------------------
// Recording terminal seam

class FakeTerminal implements TerminalIntegrationTerminal {
  statuses: TerminalProgramStatus[] = []
  progress: boolean[] = []
  progressFallback: boolean[] = []
  titles: string[] = []
  saved = 0
  restored = 0
  focusReporting: boolean[] = []
  supported = false
  focused: boolean | undefined = undefined
  supportListener: ((supported: boolean) => void) | null = null
  focusListener: ((focused: boolean) => void) | null = null
  /** When true the terminal does not expose the optional focus/progress seam. */
  minimal = false

  get programStatusSupported(): boolean {
    return this.supported
  }

  get terminalFocused(): boolean | undefined {
    return this.focused
  }

  setProgramStatus(status: TerminalProgramStatus): void {
    this.statuses.push(status)
  }

  setProgress(active: boolean): void {
    this.progress.push(active)
  }

  setTitle(title: string): void {
    this.titles.push(title)
  }

  saveTitle(): void {
    this.saved += 1
  }

  restoreTitle(): void {
    this.restored += 1
  }

  setFocusReporting(enabled: boolean): void {
    this.focusReporting.push(enabled)
  }

  setProgressFallback?(enabled: boolean): void

  onProgramStatusSupportChange?(listener: (supported: boolean) => void): () => void

  onFocusChange?(listener: (focused: boolean) => void): () => void
}

function fakeTerminal(options: { minimal?: boolean; supported?: boolean; focused?: boolean } = {}): FakeTerminal {
  const terminal = new FakeTerminal()
  terminal.supported = options.supported === true
  terminal.focused = options.focused
  if (options.minimal === true) return terminal
  terminal.setProgressFallback = (enabled: boolean) => { terminal.progressFallback.push(enabled) }
  terminal.onProgramStatusSupportChange = (listener) => {
    terminal.supportListener = listener
    listener(terminal.programStatusSupported)
    return () => { terminal.supportListener = null }
  }
  terminal.onFocusChange = (listener) => {
    terminal.focusListener = listener
    return () => { terminal.focusListener = null }
  }
  return terminal
}

// ---------------------------------------------------------------------------
// Fixtures

function sessionInfo(overrides: Partial<SessionInfo> & { title?: string | null } = {}): SessionInfo {
  return {
    sessionId: 'session-a',
    cwd: '/work/dsh-tui',
    provider: 'fixture-provider',
    model: 'fixture-model',
    capabilities: [],
    events: [],
    ...overrides,
  } as SessionInfo
}

function snapshot(overrides: Partial<TerminalPresentationSnapshot> = {}): TerminalPresentationSnapshot {
  return {
    info: sessionInfo(),
    connected: true,
    fatal: false,
    busy: false,
    decisions: [],
    subagents: [],
    ...overrides,
  }
}

function decision(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return { id: 'decision-1', kind: 'approval', title: 'Run rm -rf build', ...overrides }
}

function child(id: string, status: SubagentStatus, overrides: Partial<SubagentEntry> = {}): SubagentEntry {
  return { id, parentSessionId: 'session-a', mode: 'one-shot', status, ...overrides }
}

interface Harness {
  terminal: FakeTerminal
  out: string[]
  settings: { terminalStatus: boolean; terminalTitle: boolean; terminalNotifications: 'auto' | 'off' | 'always' }
  integration: TerminalIntegration
  notifications: () => string[]
  osc7: () => string[]
  update: (overrides?: Partial<TerminalPresentationSnapshot>) => void
}

function harness(options: {
  env?: TerminalEnvironment
  settings?: Partial<TerminalIntegrationSettings>
  minimal?: boolean
  supported?: boolean
  focused?: boolean
  hostname?: string
  processCwd?: string
} = {}): Harness {
  const terminal = fakeTerminal({
    minimal: options.minimal,
    supported: options.supported,
    ...(options.focused === undefined ? {} : { focused: options.focused }),
  })
  const out: string[] = []
  const settings: Harness['settings'] = {
    terminalStatus: true,
    terminalTitle: true,
    terminalNotifications: 'auto',
    ...options.settings,
  }
  const integration = new TerminalIntegration({
    terminal,
    cwd: () => options.processCwd ?? '/work/dsh-tui',
    env: options.env ?? terminalEnvironment({ TERM_PROGRAM: 'xterm-256color', TERM: 'xterm-256color' }),
    write: (data: string) => { out.push(data) },
    hostname: () => options.hostname ?? 'studio',
  })
  return {
    terminal,
    out,
    settings,
    integration,
    notifications: () => out.filter(item => item.startsWith('\x1b]777;')),
    osc7: () => out.filter(item => item.startsWith('\x1b]7;')),
    update: (overrides) => { integration.update(snapshot(overrides), settings) },
  }
}

const GHOSTTY: TerminalEnvironment = { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' }

let sequence = 100

function turnEvent(type: string, data: unknown, seq: number = (sequence += 1), sessionId = 'session-a'): BackendEvent {
  const event: SessionEvent = { type, seq, data }
  return { type: 'session_event', sessionId, event }
}

const turnEnd = (kind: string, turn = 1, seq?: number, sessionId = 'session-a'): BackendEvent =>
  turnEvent('turn/end', { turn, reason: { kind } }, seq, sessionId)

const lastStatus = (h: Harness): TerminalProgramStatus => {
  const value = h.terminal.statuses.at(-1)
  assert.ok(value !== undefined, 'a status record was written')
  return value
}

// ---------------------------------------------------------------------------
// Protocol helpers

test('protocol helpers: ids, file URLs, families and turn-end classification', () => {
  const id = terminalChildRecordId('session-a/child-1')
  assert.match(id, /^child-[0-9a-f]{16}$/, 'child ids are protocol-safe and stable')
  assert.equal(id, terminalChildRecordId('session-a/child-1'), 'hashed ids are deterministic')
  assert.notEqual(id, terminalChildRecordId('session-a/child-2'))
  assert.ok(id.length <= 32, 'one segment stays inside the 32-byte segment cap')

  assert.equal(terminalFileUrl('/work/dsh-tui', 'studio'), 'file://studio/work/dsh-tui')
  assert.equal(terminalFileUrl('/work/a b', 'studio'), 'file://studio/work/a%20b')
  assert.equal(terminalFileUrl('relative/path', 'studio'), null, 'relative paths are never reported')
  assert.equal(terminalFileUrl('/work/\u0007bell', 'studio'), null, 'control bytes are rejected')
  assert.equal(terminalFileUrl('/work', 'weird host;rm'), 'file://weirdhostrm/work', 'host is sanitized')

  assert.equal(detectTerminalFamily({ TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }), 'rex')
  assert.equal(detectTerminalFamily({ REX_SESSION: 'session:1' }), 'rex')
  assert.equal(detectTerminalFamily(GHOSTTY), 'ghostty')
  assert.equal(detectTerminalFamily({ TERM: 'xterm-ghostty' }), 'ghostty')
  assert.equal(detectTerminalFamily({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }), 'other')
  assert.equal(detectTerminalFamily({}), 'unknown')

  // Explicit identity wins over inherited multiplexer/host traces: a Ghostty
  // started from a Rex shell inherits REX_SESSION and must stay Ghostty.
  assert.equal(detectTerminalFamily({
    TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty', REX_SESSION: 'session:1', REX_BLOCK: 'block:1',
  }), 'ghostty', 'inherited REX_* must not turn Ghostty into Rex')
  // And a Rex app started from Ghostty can inherit GHOSTTY_RESOURCES_DIR.
  assert.equal(detectTerminalFamily({
    TERM_PROGRAM: 'rex', TERM: 'xterm-rex', GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources',
  }), 'rex', 'inherited Ghostty resources must not turn Rex into Ghostty')
  assert.equal(detectTerminalFamily({ REX_BLOCK: 'block:1' }), 'rex', 'weak hints still identify an unlabeled host')

  for (const kind of ['completed', 'error', 'max-tokens', 'interrupted', 'aborted', 'blocked', 'forked'] as const) {
    assert.equal(classifyTurnEnd({ kind }), kind)
  }
  assert.equal(classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), 'aborted')
  assert.equal(classifyTurnEnd({ kind: 'mystery' }), 'unknown')
  assert.equal(classifyTurnEnd(undefined), 'unknown')
})

// ---------------------------------------------------------------------------
// Root record lifecycle

test('root status: idle → working → done from durable facts only', () => {
  const h = harness()
  h.integration.update(snapshot(), h.settings)
  assert.deepEqual(h.terminal.statuses, [], 'no terminal writes before start()')

  h.integration.start()
  assert.deepEqual(h.terminal.statuses, [{ state: 'idle', app: TERMINAL_APP_ID }])

  h.integration.update(snapshot({ busy: true }), h.settings)
  assert.deepEqual(lastStatus(h), { state: 'working', app: TERMINAL_APP_ID, message: 'Working' })
  const written = h.terminal.statuses.length

  // Repeated frames are presentation no-ops (never per token / per render).
  for (let index = 0; index < 25; index += 1) h.integration.update(snapshot({ busy: true }), h.settings)
  assert.equal(h.terminal.statuses.length, written, 'stable state emits once per transition')

  h.integration.observe(turnEnd('completed', 7))
  assert.deepEqual(lastStatus(h), { state: 'done', app: TERMINAL_APP_ID, message: 'Turn complete' })
  h.integration.update(snapshot(), h.settings)
  assert.equal(lastStatus(h).state, 'done', 'a settled outcome survives later idle frames')

  h.integration.ack()
  assert.deepEqual(lastStatus(h), { state: 'idle', app: TERMINAL_APP_ID }, 'ack returns to idle')
  assert.equal(h.integration.view.root.state, 'idle')
})

test('transport noise never becomes a terminal outcome', () => {
  const h = harness()
  h.integration.start()
  h.integration.update(snapshot({ busy: true }), h.settings)
  const before = h.terminal.statuses.length

  const noise: BackendEvent[] = [
    { type: 'stream_start', sessionId: 'session-a', attemptId: 'a', revision: 1, turn: 1, step: 1 },
    { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'a', revision: 2, index: 1, chunk: { type: 'text', text: 'hi' } },
    { type: 'stream_end', sessionId: 'session-a', attemptId: 'a', revision: 3, outcome: 'abandoned' },
    { type: 'stream_end', sessionId: 'session-a', attemptId: 'a', revision: 4, outcome: 'committed' },
    { type: 'warning', message: 'provider hiccup' },
    { type: 'error', message: 'agent/error is diagnostic' },
    { type: 'metrics', sessionId: 'session-a', usage: { used: 1, size: 2 } },
    { type: 'todos', sessionId: 'session-a', value: [] },
    { type: 'permissions', sessionId: 'session-a', value: { currentValue: 'default' } },
    turnEvent('command/done', { commandId: 'c1', kind: 'error' }, 200),
    turnEvent('assistant/message', { text: 'done!' }, 201),
  ]
  for (const event of noise) h.integration.observe(event)

  assert.equal(h.terminal.statuses.length, before, 'tentative/derived facts never change status')
  assert.deepEqual(h.notifications(), [], 'and never notify')
  h.integration.update(snapshot({ busy: true }), h.settings)
  assert.equal(lastStatus(h).state, 'working')
})

test('turn/end reasons: only completed/error are terminal, cancellations are idle', () => {
  const cases: Array<{ kind: string; state: string; message?: string; notify: boolean }> = [
    { kind: 'completed', state: 'done', message: 'Turn complete', notify: true },
    { kind: 'error', state: 'error', message: 'Turn failed', notify: true },
    { kind: 'max-tokens', state: 'idle', message: 'Output limit reached', notify: false },
    { kind: 'interrupted', state: 'idle', notify: false },
    { kind: 'aborted', state: 'idle', notify: false },
    { kind: 'blocked', state: 'idle', notify: false },
    { kind: 'forked', state: 'idle', notify: false },
  ]
  for (const item of cases) {
    const h = harness({ env: GHOSTTY, focused: false })
    h.integration.start()
    h.integration.update(snapshot({ busy: true }), h.settings)
    h.integration.observe(turnEnd(item.kind, 3))
    h.integration.update(snapshot(), h.settings)
    const status = lastStatus(h)
    assert.equal(status.state, item.state, `${item.kind} → ${item.state}`)
    if (item.message === undefined) assert.equal(status.message, undefined, `${item.kind} carries no message`)
    else assert.equal(status.message, item.message)
    if (item.state === 'error') assert.equal(h.terminal.statuses.some(value => value.state === 'done'), false)
    assert.equal(h.notifications().length, item.notify ? 1 : 0, `${item.kind} notification policy`)
  }
})

test('an unknown turn/end reason keeps the current presentation', () => {
  const h = harness()
  h.integration.start()
  h.integration.update(snapshot({ busy: true }), h.settings)
  h.integration.observe(turnEvent('turn/end', { turn: 4, reason: { kind: 'future-kind' } }, 300))
  assert.equal(lastStatus(h).state, 'working', 'unrecognized reasons never guess done/error')
  h.integration.update(snapshot({ busy: false }), h.settings)
  assert.equal(lastStatus(h).state, 'idle', 'idle still comes from native busy, not the reason')
})

test('turn/end arrives before status idle; a live turn alone is working', () => {
  const h = harness()
  h.integration.start()
  h.integration.observe(turnEvent('turn/start', { turn: 5 }, 400))
  assert.equal(lastStatus(h).state, 'working', 'an open turn is native work')
  h.integration.observe(turnEnd('completed', 5, 401))
  assert.equal(lastStatus(h).state, 'done', 'durable end wins while status is still running')
  h.integration.observe({ type: 'status', sessionId: 'session-a', status: 'idle' })
  assert.equal(lastStatus(h).state, 'done', 'a later idle never erases a settled outcome')
})

// ---------------------------------------------------------------------------
// Decisions

test('pending native decisions are blocked with the protocol kind (approval → permission)', () => {
  const h = harness({ env: GHOSTTY, focused: false })
  h.integration.start()
  h.integration.update(snapshot({ decisions: [decision()] }), h.settings)
  assert.deepEqual(lastStatus(h), {
    state: 'blocked', app: TERMINAL_APP_ID, kind: 'permission', message: 'Waiting for approval',
  })
  assert.deepEqual(h.notifications(), ['\x1b]777;notify;dsh-tui;Waiting for approval\x07'])

  h.integration.update(snapshot({ decisions: [decision({ id: 'q', kind: 'question' })] }), h.settings)
  assert.deepEqual(lastStatus(h), {
    state: 'blocked', app: TERMINAL_APP_ID, kind: 'question', message: 'Waiting for your answer',
  })
  assert.equal(h.notifications().length, 2, 'a different decision is a new transition')

  h.integration.update(snapshot({ decisions: [], busy: true }), h.settings)
  assert.equal(lastStatus(h).state, 'working', 'closing a decision returns to native work, never done')
})

test('a child-attributed decision keeps a bounded label and a bounded child record', () => {
  const h = harness()
  h.integration.start()
  const origin = { rootSessionId: 'session-a', childSessionId: 'child-1', label: 'review the failing test' }
  h.integration.update(snapshot({
    decisions: [decision({ origin })],
    subagents: [child('child-1', 'running', { label: 'review the failing test' })],
  }), h.settings)
  assert.equal(lastStatus(h).message, 'review the failing test: Waiting for approval')
  const childRecord = h.terminal.statuses.filter(item => item.id !== undefined).at(-1)
  assert.ok(childRecord !== undefined)
  assert.equal(childRecord.state, 'blocked')
  assert.equal(childRecord.kind, 'permission')
  assert.equal(childRecord.id, terminalChildRecordId('session-a/child-1'))
})

test('local UI surfaces (settings/help/pickers) never create a blocked record', () => {
  const h = harness()
  h.integration.start()
  // The controller has no dialog input at all: only native decisions block.
  h.integration.update(snapshot({ busy: false }), h.settings)
  assert.equal(h.terminal.statuses.filter(item => item.state === 'blocked').length, 0)
  assert.equal(h.integration.view.root.state, 'idle')
})

// ---------------------------------------------------------------------------
// Children

test('child records: native states, live-activation gate, stable ids, cleared when retired', () => {
  const h = harness()
  h.integration.start()
  const live = { lastRunId: 'run-1' }
  const statuses: SubagentStatus[] = ['initializing', 'running', 'idle', 'completed', 'failed', 'stopped', 'max-tokens', 'refusal']
  h.integration.update(snapshot({
    subagents: statuses.map((status, index) => child('c' + index, status, { label: 'worker ' + index, ...live })),
  }), h.settings)
  const records = h.terminal.statuses.filter(item => item.id !== undefined)
  const byId = new Map(records.map(item => [item.id as string, item]))
  const expect: Record<string, string> = {
    initializing: 'working', running: 'working', idle: 'idle', completed: 'done', failed: 'error',
    stopped: 'idle', 'max-tokens': 'error', refusal: 'error',
  }
  statuses.forEach((status, index) => {
    const record = byId.get(terminalChildRecordId('session-a/c' + index))
    assert.ok(record !== undefined, `${status} child has a record`)
    assert.equal(record.state, expect[status], `${status} → ${expect[status]}`)
    assert.equal(record.app, TERMINAL_APP_ID)
    assert.equal(record.title, 'worker ' + index)
    assert.match(record.id as string, /^child-[0-9a-f]{16}$/)
  })
  assert.equal(new Set(records.map(item => item.id)).size, records.length, 'ids are unique')

  // Retiring a child clears exactly its record.
  h.integration.update(snapshot({ subagents: [child('c1', 'running', { label: 'worker 1', ...live })] }), h.settings)
  const clears = h.terminal.statuses.filter(item => item.state === 'clear')
  assert.equal(clears.length, statuses.length - 1)
  assert.ok(clears.every(item => typeof item.id === 'string'))
  assert.equal(h.integration.view.children.length, 1)
})

test('child records never aggregate into root status', () => {
  const h = harness()
  h.integration.start()
  h.integration.update(snapshot({ busy: false, subagents: [child('c1', 'running', { label: 'worker' })] }), h.settings)
  assert.deepEqual(lastStatus(h), { state: 'idle', app: TERMINAL_APP_ID }, 'root stays native idle')
  assert.equal(h.integration.view.children[0].state, 'working')
  assert.equal(h.integration.view.root.state, 'idle')
})

test('child budget is root + 63 records, blocked/failed/running first', () => {
  const h = harness()
  h.integration.start()
  const entries: SubagentEntry[] = []
  for (let index = 0; index < 80; index += 1) {
    const status: SubagentStatus = index % 4 === 0 ? 'running' : index % 4 === 1 ? 'failed' : index % 4 === 2 ? 'completed' : 'idle'
    entries.push(child('budget-' + index, status, { label: 'worker ' + index }))
  }
  h.integration.update(snapshot({ subagents: entries }), h.settings)
  assert.equal(h.integration.view.children.length, MAX_CHILD_RECORDS)
  assert.equal(MAX_CHILD_RECORDS, 63, 'one root record + 63 children = the protocol minimum of 64')
  const states = h.integration.view.children.map(item => item.state)
  const rank = (state: string): number => ({ blocked: 0, error: 1, working: 2, done: 3, idle: 4 } as Record<string, number>)[state]
  for (let index = 1; index < states.length; index += 1) {
    assert.ok(rank(states[index - 1]) <= rank(states[index]), 'higher-signal records are kept first')
  }
  assert.ok(states.includes('working'))
})

test('a decision for a child missing from the bounded catalog still gets one record', () => {
  const h = harness()
  h.integration.start()
  h.integration.update(snapshot({
    decisions: [decision({ origin: { rootSessionId: 'session-a', childSessionId: 'cold-child', label: 'cold' } })],
  }), h.settings)
  const childRecord = h.terminal.statuses.find(item => item.id === terminalChildRecordId('session-a/cold-child'))
  assert.ok(childRecord !== undefined)
  assert.equal(childRecord.state, 'blocked')
  assert.equal(childRecord.title, 'cold')
})

// ---------------------------------------------------------------------------
// Notification policy

test('auto notifications: Ghostty + positive unfocused evidence only', () => {
  const unfocused = harness({ env: GHOSTTY, focused: false })
  unfocused.integration.start()
  unfocused.integration.observe(turnEnd('completed', 2))
  assert.deepEqual(unfocused.notifications(), ['\x1b]777;notify;dsh-tui;Turn complete\x07'])

  const focused = harness({ env: GHOSTTY, focused: true })
  focused.integration.start()
  focused.integration.observe(turnEnd('completed', 2))
  assert.deepEqual(focused.notifications(), [], 'a focused terminal is not interrupted')

  const unknown = harness({ env: GHOSTTY })
  unknown.integration.start()
  unknown.integration.observe(turnEnd('completed', 2))
  assert.deepEqual(unknown.notifications(), [], 'auto needs positive unfocused evidence')

  const rex = harness({ env: { TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }, focused: false })
  rex.integration.start()
  rex.integration.observe(turnEnd('completed', 2))
  assert.deepEqual(rex.notifications(), [], 'Rex shows program status natively; no duplicate alert')

  const unsupportedGhostty = harness({ env: GHOSTTY, focused: false, supported: false })
  unsupportedGhostty.integration.start()
  unsupportedGhostty.integration.observe(turnEnd('error', 2))
  assert.deepEqual(unsupportedGhostty.notifications(), ['\x1b]777;notify;dsh-tui;Turn failed\x07'],
    'Ghostty notification policy is independent of a 7501 reply')
})

test('always forces transition notifications even when status is shown natively', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }, settings: { terminalNotifications: 'always' }, focused: true })
  h.integration.start()
  h.update()
  h.integration.observe(turnEnd('completed', 1))
  assert.deepEqual(h.notifications(), ['\x1b]777;notify;dsh-tui;Turn complete\x07'])
  h.integration.observe(turnEnd('error', 2))
  assert.equal(h.notifications().length, 2)
})

test('off disables only explicit notifications, never the published status', () => {
  const h = harness({ env: GHOSTTY, focused: false, settings: { terminalNotifications: 'off' } })
  h.update()
  h.integration.start()
  assert.deepEqual(h.terminal.focusReporting, [], 'off never enables focus reporting')
  h.integration.observe(turnEnd('completed', 1))
  assert.deepEqual(h.notifications(), [])
  assert.equal(lastStatus(h).state, 'done', 'status stays published')

  // Switching back to auto enables exact focus reporting, never a timer.
  h.settings.terminalNotifications = 'auto'
  h.update()
  assert.deepEqual(h.terminal.focusReporting, [true])
})

test('notifications are deduplicated per transition and reset only on a new one', () => {
  const h = harness({ env: GHOSTTY, focused: false })
  h.integration.start()
  h.integration.observe(turnEnd('completed', 1))
  for (let index = 0; index < 10; index += 1) h.integration.update(snapshot(), h.settings)
  assert.equal(h.notifications().length, 1)
  h.integration.ack()
  h.integration.observe(turnEnd('completed', 2))
  assert.equal(h.notifications().length, 2, 'a later turn is a new transition')
})

test('notification bodies are fixed, bounded and privacy-safe', () => {
  const h = harness({ env: GHOSTTY, focused: false })
  h.integration.start()
  h.integration.update(snapshot({ decisions: [decision({ title: 'rm -rf /secret/path /*prompt*/' })] }), h.settings)
  const body = h.notifications()[0]
  assert.equal(body, '\x1b]777;notify;dsh-tui;Waiting for approval\x07')
  for (const secret of ['rm -rf', 'secret', 'prompt', '/work']) assert.equal(body.includes(secret), false)
  const allowed = new Set(['Working', 'Waiting for approval', 'Waiting for your answer', 'Turn complete', 'Turn failed', 'Output limit reached'])
  for (const status of h.terminal.statuses) {
    if (status.message !== undefined) assert.ok(allowed.has(status.message), `fixed vocabulary: ${status.message}`)
  }
})

test('focus events drive auto policy without reading stdin', () => {
  const h = harness({ env: GHOSTTY })
  h.update()
  h.integration.start()
  assert.deepEqual(h.terminal.focusReporting, [true], 'auto enables focus reporting')
  h.integration.observe(turnEnd('completed', 1))
  assert.deepEqual(h.notifications(), [], 'unknown focus stays silent')

  h.terminal.focusListener?.(false)
  assert.equal(h.integration.view.focus, 'unfocused')
  h.integration.observe(turnEnd('completed', 2))
  assert.equal(h.notifications().length, 1)

  h.terminal.focusListener?.(true)
  h.integration.observe(turnEnd('completed', 3))
  assert.equal(h.notifications().length, 1, 'focus regained suppresses the next transition')
})

test('handleFocusReport is an exact custom-terminal fallback, never a second input owner', () => {
  const withEvents = harness({ env: GHOSTTY, focused: false })
  withEvents.integration.start()
  assert.equal(withEvents.integration.handleInput('\x1b[O'), false, 'the terminal owns focus input')

  const minimal = harness({ env: GHOSTTY, minimal: true })
  minimal.update()
  minimal.integration.start()
  assert.equal(minimal.integration.handleInput('\x1b[O'), true)
  assert.equal(minimal.integration.view.focus, 'unfocused')
  assert.equal(minimal.integration.handleInput('\x1b[I'), true)
  assert.equal(minimal.integration.view.focus, 'focused')
  for (const other of ['', 'o', '\x1b', '\x1b[1;5I', '\x1b[200~\x1b[O\x1b[201~', '\x1b[Oextra']) {
    assert.equal(minimal.integration.handleInput(other), false, `not consumed: ${JSON.stringify(other)}`)
  }
})

// ---------------------------------------------------------------------------
// Progress

test('progress: legacy fallback only where the GUI needs it', () => {
  const rex = harness({ env: { TERM_PROGRAM: 'rex', TERM: 'xterm-rex' } })
  rex.integration.start()
  rex.integration.update(snapshot({ busy: true }), rex.settings)
  assert.deepEqual(rex.terminal.progress, [true])
  assert.deepEqual(rex.terminal.progressFallback, [], 'other hosts keep the seam auto policy (no explicit false)')
  rex.integration.update(snapshot({ busy: false }), rex.settings)
  assert.deepEqual(rex.terminal.progress, [true, false])

  const ghostty = harness({ env: GHOSTTY, supported: true })
  ghostty.integration.start()
  assert.deepEqual(ghostty.terminal.progressFallback, [true], 'Ghostty opts in even after a 7501 reply')
  ghostty.integration.update(snapshot({ busy: true }), ghostty.settings)
  assert.deepEqual(ghostty.terminal.progress, [true])

  const rexSupported = harness({ env: { TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }, supported: true })
  rexSupported.integration.start()
  rexSupported.integration.update(snapshot({ busy: true }), rexSupported.settings)
  assert.deepEqual(rexSupported.terminal.progress, [], 'no legacy 9;4 once rich support is confirmed')
  assert.deepEqual(rexSupported.terminal.progressFallback, [])
})

test('support confirmation drops the legacy bar and re-emits without re-owning title/workspace', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }, supported: false })
  h.integration.start()
  h.update({ busy: true, info: sessionInfo({ title: 'Native title' }) })
  assert.deepEqual(h.terminal.progress, [true])
  const before = h.terminal.statuses.length
  const saves = h.terminal.saved
  const workspaceWrites = h.osc7().length

  h.terminal.supported = true
  h.terminal.supportListener?.(true)
  assert.deepEqual(h.terminal.progress, [true, false], 'the heartbeat stops at once')
  assert.ok(h.terminal.statuses.length > before, 'the current record is replayed on the new channel')
  assert.equal(lastStatus(h).state, 'working')
  assert.equal(h.terminal.saved, saves, 'a support change never pushes another title save')
  assert.equal(h.osc7().length, workspaceWrites, 'and never rewrites OSC 7')
})

// ---------------------------------------------------------------------------
// Title / workspace (OSC 0 / OSC 7)

test('title: native session title, workspace fallback, no status glyph', () => {
  const h = harness()
  h.integration.start()
  assert.deepEqual(h.terminal.titles, ['dsh-tui · dsh-tui'])
  assert.equal(h.terminal.saved, 1, 'the previous title is saved before the first write')

  h.integration.update(snapshot({ info: sessionInfo({ title: 'Fix the failing test' }) }), h.settings)
  assert.equal(h.terminal.titles.at(-1), 'Fix the failing test — dsh-tui')
  assert.doesNotMatch(h.terminal.titles.at(-1) as string, /[✳✻·]|working|done/, 'no spinner/status glyph')

  for (let index = 0; index < 5; index += 1) h.integration.update(snapshot({ info: sessionInfo({ title: 'Fix the failing test' }) }), h.settings)
  assert.equal(h.terminal.titles.length, 2, 'one write per title change')

  h.integration.update(snapshot({ info: sessionInfo({ title: 'bell\u0007and\u001b[31mansi' }) }), h.settings)
  assert.equal(h.terminal.titles.at(-1), 'bell and ansi — dsh-tui', 'control bytes are stripped')

  h.integration.update(snapshot({ info: sessionInfo({ title: 'x'.repeat(400) }) }), h.settings)
  assert.ok((h.terminal.titles.at(-1) as string).length <= 160 + ' — dsh-tui'.length)
})

test('Rex neutral icon classification applies to root, children and fatal reports only in Rex', () => {
  for (const [env, app] of [
    [{ TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }, 'terminal'],
    [{ REX_SESSION: 'fixture-rex' }, 'terminal'],
    [{ ...GHOSTTY, REX_SESSION: 'inherited-rex' }, 'dsh-tui'],
    [{ TERM_PROGRAM: 'fixture', TERM: 'xterm-256color' }, 'dsh-tui'],
  ] as const) {
    const h = harness({ env, supported: true })
    const info = sessionInfo({ title: 'Native identity' })
    h.integration.update(snapshot({ info, subagents: [child('worker', 'running', { label: 'Native child' })] }), h.settings)
    h.integration.start()
    const records = h.terminal.statuses.filter(record => record.state !== 'clear')
    assert.ok(records.some(record => record.id === undefined && record.app === app))
    assert.ok(records.some(record => record.id !== undefined && record.app === app && record.title === 'Native child'))
    assert.ok(h.terminal.titles.at(-1)?.endsWith('Native identity — dsh-tui'))
    assert.equal(info.title, 'Native identity')
    h.integration.update(snapshot({ info, fatal: true }), h.settings)
    assert.ok(h.terminal.statuses.some(record => record.state === 'error' && record.app === app))
    assert.ok(h.terminal.statuses.filter(record => record.state !== 'clear').every(record => record.app === app))
    h.integration.dispose()
  }
})

test('Rex icon classification never renames DSH notifications or forces reporting when status is off', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex' }, settings: { terminalStatus: false, terminalNotifications: 'always' } })
  h.integration.update(snapshot(), h.settings)
  h.integration.start()
  h.update({ decisions: [decision()] })
  assert.deepEqual(h.terminal.statuses, [], 'status off does not publish a fake icon-only record')
  assert.ok(h.notifications()[0]?.startsWith('\x1b]777;notify;dsh-tui;'))
  assert.ok(h.terminal.titles.at(-1)?.endsWith('dsh-tui · dsh-tui'))
  h.settings.terminalStatus = true
  h.update({ decisions: [decision()] })
  assert.equal(lastStatus(h).app, 'terminal')
  h.settings.terminalStatus = false
  h.update()
  assert.equal(lastStatus(h).state, 'clear')
  h.integration.dispose()
})

test('Rex title keeps only the static whale across native work and repeated renders', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex', TERM: 'xterm-rex' }, supported: true })
  const info = Object.freeze(sessionInfo({ title: 'Native title 中文' }))
  h.integration.update(snapshot({ info }), h.settings)
  h.integration.start()
  assert.equal(h.terminal.titles.at(-1), '🐳 Native title 中文 — dsh-tui')
  const titles = h.terminal.titles.length
  h.integration.update(snapshot({ info, busy: true }), h.settings)
  const reports = h.terminal.statuses.length
  for (let index = 0; index < 25; index++) h.integration.update(snapshot({ info, busy: true }), h.settings)
  assert.equal(h.terminal.titles.length, titles, 'native work and UI redraws never rewrite the title')
  assert.equal(h.terminal.statuses.length, reports, 'no status heartbeat')
  assert.deepEqual(h.notifications(), [])
  assert.equal(info.title, 'Native title 中文')
  assert.equal(h.terminal.saved, 1)
  assert.ok(h.terminal.statuses.every(record => record.app === 'terminal'))
  assert.ok(h.terminal.titles.every(title => title.startsWith('🐳 ') && !/[✦⠂⠐]/u.test(title)))
  h.integration.dispose()
})

test('Rex static title changes only with native title or workspace', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex' } })
  h.integration.start()
  h.update({ busy: true })
  assert.equal(h.terminal.titles.at(-1), '🐳 dsh-tui · dsh-tui')
  assert.equal(h.terminal.titles.length, 1)
  h.update({ busy: true, info: sessionInfo({ title: 'Renamed natively' }) })
  assert.equal(h.terminal.titles.at(-1), '🐳 Renamed natively — dsh-tui')
  h.update({ busy: true, info: sessionInfo({ title: null, cwd: '/work/other' }) })
  assert.equal(h.terminal.titles.at(-1), '🐳 dsh-tui · other')
  assert.equal(h.terminal.titles.length, 3)
  assert.equal(h.terminal.saved, 1)
  h.integration.dispose()
})

test('non-Rex titles stay unchanged even with rich status or inherited Rex hints', () => {
  for (const env of [GHOSTTY, { ...GHOSTTY, REX_SESSION: 'inherited-rex' }, { TERM_PROGRAM: 'fixture', TERM: 'xterm-256color' }]) {
    const h = harness({ env, supported: true })
    h.integration.start()
    for (const busy of [false, true, false]) h.update({ info: sessionInfo({ title: 'Plain native title' }), busy })
    assert.equal(h.terminal.titles.at(-1), 'Plain native title — dsh-tui')
    assert.ok(h.terminal.titles.every(title => !title.includes('🐳')))
    h.integration.dispose()
  }
})

test('native decisions, outcomes and independent children never decorate the whale title', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex' }, supported: true })
  h.integration.start()
  const count = h.terminal.titles.length
  h.update({ busy: true, decisions: [decision()] })
  assert.equal(h.integration.view.root.state, 'blocked')
  h.update({ busy: true, decisions: [] })
  assert.equal(h.integration.view.root.state, 'working')
  h.integration.observe(turnEnd('completed', 1))
  assert.equal(h.integration.view.root.state, 'done')
  h.integration.ack()
  h.update({ busy: false, subagents: [child('worker', 'running', { label: 'Native child' })] })
  assert.equal(h.integration.view.root.state, 'idle')
  assert.equal(h.terminal.titles.at(-1), '🐳 dsh-tui · dsh-tui')
  assert.equal(h.terminal.titles.length, count)
  assert.ok(h.terminal.statuses.some(record => record.id !== undefined && record.title === 'Native child' && record.state === 'working'))
  h.integration.dispose()
})

test('Rex static title toggle is independent of status and silent after terminal handoff', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex' }, settings: { terminalStatus: false } })
  h.integration.update(snapshot(), h.settings)
  h.integration.start()
  h.update({ busy: true })
  assert.equal(h.terminal.titles.at(-1), '🐳 dsh-tui · dsh-tui')
  assert.deepEqual(h.terminal.statuses, [])
  h.settings.terminalTitle = false
  h.update({ busy: true })
  const count = h.terminal.titles.length
  h.update({ busy: true })
  assert.equal(h.terminal.titles.length, count)
  assert.equal(h.terminal.restored, 1)
  h.settings.terminalTitle = true
  h.update({ busy: true })
  assert.equal(h.terminal.titles.at(-1), '🐳 dsh-tui · dsh-tui')
  h.integration.pause()
  const paused = h.terminal.titles.length
  h.update({ busy: true })
  assert.equal(h.terminal.titles.length, paused)
  h.integration.resume()
  assert.equal(h.terminal.titles.at(-1), '🐳 dsh-tui · dsh-tui')
  h.integration.dispose()
  const disposed = h.terminal.titles.length
  h.update({ busy: true })
  h.integration.observe(turnEnd('completed', 2))
  assert.equal(h.terminal.titles.length, disposed)
})

test('Rex title keeps native text sanitized and bounded after its static whale marker', () => {
  const h = harness({ env: { TERM_PROGRAM: 'rex' } })
  h.integration.start()
  h.update({ info: sessionInfo({ title: 'name\u0007\u001b[31m\u202eevil' }) })
  assert.equal(h.terminal.titles.at(-1), '🐳 name evil — dsh-tui')
  h.update({ info: sessionInfo({ title: '中'.repeat(400) }) })
  assert.ok([...h.terminal.titles.at(-1)!].length <= 160 + [...'🐳  — dsh-tui'].length, 'keep the existing code-point bound')
  h.integration.dispose()
})

test('terminalTitle off restores the delegated title without disabling native directory reporting', () => {
  const h = harness()
  h.integration.start()
  h.update()
  assert.match(h.osc7()[0], /^\x1b\]7;file:\/\/studio\/work\/dsh-tui\x1b\\$/)
  assert.equal(h.terminal.titles.at(-1), 'dsh-tui · dsh-tui')

  h.settings.terminalTitle = false
  h.update()
  assert.equal(h.terminal.restored, 1, 'restoreTitle is delegated to the terminal stack')
  assert.equal(h.terminal.saved, 1, 'and the first save is not repeated')

  const writes = h.osc7().length
  h.update({ info: sessionInfo({ cwd: '/work/other' }) })
  assert.equal(h.osc7().length, writes + 1, 'native workspace changes remain reportable while title presentation is off')

  h.settings.terminalTitle = true
  h.update({ info: sessionInfo({ cwd: '/work/other' }) })
  assert.equal(h.osc7().at(-1), '\x1b]7;file://studio/work/other\x1b\\', 'the current workspace stays correct')
  assert.equal(h.terminal.saved, 2, 're-enabling saves the title again before writing')
})

test('OSC 7 reports the native DSH workspace, not a fabricated prompt', () => {
  const h = harness({ processCwd: '/Users/someone/project' })
  h.integration.start()
  assert.deepEqual(h.osc7(), [], 'no native workspace yet, so nothing is reported')

  h.update()
  assert.deepEqual(h.osc7(), ['\x1b]7;file://studio/work/dsh-tui\x1b\\'])
  h.update({ info: sessionInfo({ cwd: '/work/with space/dir' }) })
  assert.deepEqual(h.osc7().at(-1), '\x1b]7;file://studio/work/with%20space/dir\x1b\\')
  const writes = h.osc7().length
  h.update({ info: sessionInfo({ cwd: '/work/with space/dir' }) })
  assert.equal(h.osc7().length, writes, 'only native workspace changes write')

  h.integration.dispose()
  assert.deepEqual(h.osc7().at(-1), '\x1b]7;file://studio/Users/someone/project\x1b\\',
    'handoff restores the process working directory when it differs')
})

test('an unsafe native workspace is never reported', () => {
  const h = harness()
  h.integration.start()
  const writes = h.osc7().length
  h.integration.update(snapshot({ info: sessionInfo({ cwd: 'relative/dir' }) }), h.settings)
  assert.equal(h.osc7().length, writes)
})

// ---------------------------------------------------------------------------
// Preferences, lifecycle, context

test('terminalStatus off clears owned records; back on republishes', () => {
  const h = harness()
  h.integration.start()
  h.integration.update(snapshot({ busy: true, subagents: [child('c1', 'running')] }), h.settings)
  h.settings.terminalStatus = false
  h.integration.update(snapshot({ busy: true, subagents: [child('c1', 'running')] }), h.settings)
  const clears = h.terminal.statuses.filter(item => item.state === 'clear')
  assert.ok(clears.some(item => item.id !== undefined), 'the child record is cleared explicitly')
  assert.ok(clears.some(item => item.id === undefined), 'the root record is cleared')
  assert.equal(lastStatus(h).state, 'clear')
  assert.deepEqual(h.terminal.progress.at(-1), false, 'progress is not left running')

  const writes = h.terminal.statuses.length
  h.integration.update(snapshot({ busy: true }), h.settings)
  assert.equal(h.terminal.statuses.length, writes, 'off stays silent, not clear-per-frame')

  h.settings.terminalStatus = true
  h.integration.update(snapshot({ busy: true }), h.settings)
  assert.equal(lastStatus(h).state, 'working')
})

test('pause/resume restore and replay the presentation; dispose is final', () => {
  const h = harness({ env: GHOSTTY, focused: false })
  h.integration.start()
  h.integration.update(snapshot({ busy: true, subagents: [child('c1', 'running', { label: 'worker' })] }), h.settings)
  h.integration.pause()
  assert.equal(lastStatus(h).state, 'clear')
  assert.equal(h.terminal.restored, 1, 'title stack restored while paused')
  assert.deepEqual(h.terminal.focusReporting.at(-1), false)
  const paused = h.terminal.statuses.length + h.out.length
  h.integration.update(snapshot({ busy: false }), h.settings)
  h.integration.observe(turnEnd('completed', 9))
  assert.equal(h.terminal.statuses.length + h.out.length, paused, 'paused presentation writes nothing')

  h.integration.resume()
  assert.equal(lastStatus(h).state, 'done', 'resume replays the current native state')
  const disposed = h.terminal.statuses.length
  h.integration.dispose()
  assert.equal(lastStatus(h).state, 'clear')
  h.integration.update(snapshot({ busy: true }), h.settings)
  h.integration.observe(turnEnd('completed', 10))
  h.integration.dispose()
  assert.equal(h.terminal.statuses.length, disposed + 1, 'no writes after ownership is relinquished')
  assert.equal(h.integration.isDisposed, true)
})

test('a fatal backend error / closed transport reports once, then stops all writes', () => {
  for (const stop of ['fatal', 'closed'] as const) {
    const h = harness({ env: GHOSTTY, focused: false, processCwd: '/Users/someone/project' })
    h.integration.start()
    h.update({ busy: true, subagents: [child('c1', 'running', { label: 'worker', lastRunId: 'run-1' })] })
    assert.equal(lastStatus(h).state, 'working')
    const saves = h.terminal.saved
    const workspace = h.osc7().length

    if (stop === 'fatal') h.update({ fatal: true })
    else h.integration.observe({ type: 'closed', code: 1 })

    // A bounded generic error replaces the record; no raw native error text.
    assert.deepEqual(lastStatus(h), { state: 'error', app: TERMINAL_APP_ID, message: 'Session unavailable' })
    assert.ok(h.terminal.statuses.some(item => item.state === 'clear' && item.id !== undefined),
      `${stop} clears owned child records before releasing`)
    assert.deepEqual(h.terminal.progress.at(-1), false, 'the legacy bar stops')
    assert.equal(h.terminal.focusReporting.at(-1), false, 'focus reporting stops')
    assert.equal(h.terminal.restored, 1, 'the delegated title is restored')
    assert.equal(h.terminal.saved, saves, 'halting never pushes another title save')
    assert.equal(h.osc7().length, workspace + 1, 'directory tracking is restored once on handoff')
    assert.deepEqual(h.notifications(), ['\x1b]777;notify;dsh-tui;Session unavailable\x07'], 'a native fatal stop gets one privacy-safe attention event')

    const writes = h.terminal.statuses.length + h.out.length
    h.update({ busy: true })
    h.integration.observe(turnEnd('completed', 3))
    assert.equal(h.terminal.statuses.length + h.out.length, writes, `${stop} does not keep writing`)

    h.integration.resume()
    h.update({ busy: true })
    assert.equal(lastStatus(h).state, 'working', 'a halted transport never turns its late completion into resumable work')
    h.integration.observe(turnEnd('completed', 4))
    assert.equal(lastStatus(h).state, 'done', 'new authorized work after re-arming can settle normally')
    h.integration.ack()
    assert.equal(lastStatus(h).state, 'working', 'acknowledging falls back to the current native work')
  }
})

test('context changes clear outcomes/notifications; same-attachment refresh does not', () => {
  const h = harness({ env: GHOSTTY, focused: false })
  h.integration.start()
  h.update({ info: sessionInfo({ title: 'A' }) })
  h.integration.observe(turnEnd('completed', 1))
  assert.equal(h.notifications().length, 1)

  const relative = h.terminal.statuses.length
  h.update({ info: sessionInfo({ title: 'A' }) })
  assert.equal(h.terminal.statuses.length, relative, 'a same-context refresh emits nothing')
  assert.equal(h.notifications().length, 1, 'and never re-notifies')

  // A new session clears the old record and gets its own transition identity,
  // even when the new turn number matches the previous session's.
  h.update({ info: sessionInfo({ sessionId: 'session-b', title: 'B' }), subagents: [] })
  const clears = h.terminal.statuses.filter(item => item.state === 'clear')
  assert.ok(clears.some(item => item.id === undefined), 'the old root record is cleared explicitly')
  assert.equal(lastStatus(h).state, 'idle', 'a new session starts idle, not with the old outcome')
  assert.deepEqual(h.terminal.titles.at(-1), 'B — dsh-tui')

  h.integration.observe(turnEnd('completed', 1, undefined, 'session-b'))
  assert.equal(h.notifications().length, 2, 'the new context has its own transition identity')

  const attachment = h.terminal.statuses.length
  h.update({ info: sessionInfo({ sessionId: 'session-b', attachmentId: 'epoch-2', title: 'B' }) })
  assert.ok(h.terminal.statuses.length >= attachment)
  assert.equal(lastStatus(h).state, 'idle', 'a new attachment epoch clears the previous outcome')
})

test('stale and historical events never become presentation', () => {
  const h = harness({ env: GHOSTTY, focused: false })
  h.integration.start()
  const history = sessionInfo({
    events: [{ type: 'turn/end', seq: 42, data: { turn: 1, reason: { kind: 'completed' } } }],
  })
  h.integration.update(snapshot({ info: history }), h.settings)
  assert.equal(h.integration.view.root.state, 'idle', 'durable history is not a live outcome')
  h.integration.observe(turnEnd('completed', 1, 42))
  assert.equal(h.integration.view.root.state, 'idle', 'a replayed event at or below the watermark is ignored')
  assert.deepEqual(h.notifications(), [])

  h.integration.observe(turnEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, 43, 'session-z'))
  assert.equal(h.integration.view.root.state, 'idle', 'another session’s event is ignored')
  assert.deepEqual(h.notifications(), [])

  h.integration.observe(turnEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }, 43))
  assert.equal(h.integration.view.root.state, 'done', 'the live event above the watermark is accepted')
})

test('a minimal terminal without optional seams never throws and never notifies', () => {
  const h = harness({ env: GHOSTTY, minimal: true, focused: false })
  h.integration.start()
  h.integration.update(snapshot({ busy: true, decisions: [decision()] }), h.settings)
  assert.deepEqual(h.notifications(), [], 'no focus reporting → no automatic notification')
  assert.equal(h.integration.handleInput('\x1b[O'), true, 'the documented fallback still works')
  h.integration.observe(turnEnd('completed', 1))
  h.integration.dispose()
  assert.equal(lastStatus(h).state, 'clear')
})