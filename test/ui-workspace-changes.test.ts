// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '#pi-tui'
import type { SessionEvent, SessionInfo, WorkspaceChangeFile, WorkspaceChangesSummary } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { WorkspaceChangesTranscriptItem } from '../src/state/transcript.ts'
import { createItemBlock, type TranscriptViewOptions } from '../src/ui/blocks.ts'
import { cacheKeyBuilds, resetCacheKeyBuilds } from '../src/ui/render-counters.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import {
  WorkspaceChangesBlock,
  workspaceFileCountLabel,
  workspaceFileNotes,
  workspaceFileSuffix,
  type WorkspaceChangesDetailsRequest,
} from '../src/ui/workspace-changes.ts'

/**
 * Live-only native workspace summary projection + the transcript card.
 *
 * Every assertion is driven by the neutral DTO: no DSH runtime, no model, no
 * file read, no git and no stdout. The store's durable snapshot replay is
 * deliberately separate from the one live `session_event` path that may attach
 * `workspaceChanges`.
 */

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 0,
  data,
  ...extra,
})

const user = (text: string) => ({ id: `u${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const assistantWithCalls = (calls: readonly string[]): Record<string, unknown> => ({
  turn: 1,
  step: 1,
  message: {
    id: 'a-tools',
    role: 'assistant',
    content: calls.map(id => ({ type: 'tool-call', id, name: 'bash', arguments: '{"command":"echo hi"}' })),
    source: { kind: 'model', provider: 'demo', model: 'demo' },
  },
  stream: [],
})

const summary = (): WorkspaceChangesSummary => ({
  turn: 3,
  files: [
    { path: '/private/repo/src/greet.ts', display: 'src/greet.ts', added: 12, deleted: 3 },
    { path: '/private/repo/assets/logo.png', display: 'assets/logo.png', added: 0, deleted: 0, binary: true },
    { path: '/private/repo/big.json', display: 'big.json', added: 1000, deleted: 0, oversized: true },
    { path: '/private/repo/src/组件/✅.ts', display: 'src/组件/✅.ts', added: 2, deleted: 1 },
  ],
  total: 4,
  added: 1014,
  deleted: 4,
})

const liveWorkspaceEvent = (seq: number, value: WorkspaceChangesSummary = summary()): SessionEvent =>
  ev('turn/end', seq, { turn: value.turn, reason: { kind: 'completed' } }, { workspaceChanges: value })

const workspaceItems = (store: TranscriptStore): WorkspaceChangesTranscriptItem[] =>
  store.items.flatMap(item => (item.kind === 'workspace-changes' ? [item] : []))

const flags = (overrides: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions => ({
  showThinking: false,
  expandTools: false,
  screen: 'fullscreen',
  ...overrides,
})

function newStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events))
  return store
}

function blockFor(summaryValue: WorkspaceChangesSummary = summary(), overrides: Partial<TranscriptViewOptions> = {}): {
  block: WorkspaceChangesBlock
  item: WorkspaceChangesTranscriptItem
} {
  const item: WorkspaceChangesTranscriptItem = {
    kind: 'workspace-changes',
    id: `workspace-changes:turn:${summaryValue.turn}`,
    sessionId: 's1',
    attachmentId: 'attach-1',
    seq: 7,
    turn: summaryValue.turn,
    files: summaryValue.files,
    total: summaryValue.total,
    added: summaryValue.added,
    deleted: summaryValue.deleted,
    version: 1,
  }
  const created = createItemBlock(item, flags(overrides))
  assert.ok(created instanceof WorkspaceChangesBlock)
  return { block: created, item }
}

function plain(lines: readonly string[]): string {
  return stripTerminalSequences(lines.join('\n'))
}

function mouse(type: TuiMouseEvent['type'], row: number, width = 80, height = 40, x = 4): TuiMouseEvent {
  return {
    type,
    button: type === 'move' ? 'none' : 'left',
    x,
    y: row,
    screenX: x,
    screenY: row,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

// ---------------------------------------------------------------------------
// Store projection

test('a live native summary becomes one distinct turn-level card', () => {
  const store = newStore([ev('user/message', 1, user('change the files'), { surfaceOp: 'append' })])
  store.handle({
    type: 'session_event',
    sessionId: 's1',
    event: liveWorkspaceEvent(7),
  })
  const cards = workspaceItems(store)
  assert.equal(cards.length, 1, 'one native summary is one card, never one item per file')
  const card = cards[0]!
  assert.equal(card.id, 'workspace-changes:turn:3', 'identity is the native turn, not the announcing seq')
  assert.equal(card.seq, 7)
  assert.equal(card.sessionId, 's1', 'the exact live session identity is captured with the card')
  assert.equal(card.attachmentId, undefined)
  assert.equal(card.turn, 3)
  assert.equal(card.total, 4)
  assert.equal(card.added, 1014)
  assert.equal(card.deleted, 4)
  assert.equal(card.files.length, 4)
  assert.deepEqual(card.files[0], { path: '/private/repo/src/greet.ts', display: 'src/greet.ts', added: 12, deleted: 3 })
  assert.equal(card.files[1]?.binary, true)
  assert.equal(card.files[2]?.oversized, true)

  // It is NOT a tool result and has no tool status at all.
  const kinds = store.items.map(item => item.kind)
  assert.deepEqual(kinds, ['user', 'workspace-changes'])
  assert.ok(!('status' in card), 'the card never invents a tool lifecycle')

  // The native summary is copied, so the projected item never aliases the wire
  // DTO. A later immutable wire replacement (the only way a readonly DTO can
  // change) updates its own card and cannot rewrite this one.
  const wire = summary()
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(8, { ...wire, turn: 4 }) })
  const projected = workspaceItems(store)[1]!
  assert.notEqual(projected.files, wire.files, 'the projected file list is a copy, not the wire array')
  assert.notEqual(projected.files[0], wire.files[0], 'the projected file row is a copy, not the wire row')
  const changedWire: WorkspaceChangesSummary = {
    ...wire,
    turn: 5,
    added: wire.added + 1,
    files: wire.files.map((file, index) => (index === 0 ? { ...file, added: 999 } : file)),
  }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(9, changedWire) })
  assert.equal(workspaceItems(store)[1]?.files[0]?.added, 12)
  assert.equal(workspaceItems(store)[2]?.files[0]?.added, 999)
})

test('a resumed snapshot never fabricates a workspace card from a replayed field', () => {
  // Even a durable replay that happens to carry the field is not a live native
  // observation: reset() is the snapshot plane, not the live attachment plane.
  const store = newStore([liveWorkspaceEvent(7)])
  assert.equal(workspaceItems(store).length, 0)
  assert.equal(store.items.length, 0)

  // The same summary attached to a live frame after reset is a real observation.
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(8) })
  assert.equal(workspaceItems(store).length, 1)
  assert.equal(workspaceItems(store)[0]?.seq, 8)

  // A snapshot reset drops the live card again.
  store.reset(info())
  assert.equal(workspaceItems(store).length, 0)
})

test('missing and malformed native summaries append nothing', () => {
  const store = newStore()
  store.handle({ type: 'session_event', sessionId: 's1', event: ev('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }) })
  assert.equal(workspaceItems(store).length, 0, 'no native field means no card')

  const malformed: unknown[] = [
    null,
    'x',
    { turn: 1, files: [], total: 0, added: 0 },
    { turn: -1, files: [], total: 0, added: 0, deleted: 0 },
    { turn: 1, files: 'nope', total: 0, added: 0, deleted: 0 },
    { turn: 1, files: [], total: -1, added: 0, deleted: 0 },
  ]
  malformed.forEach((value, index) => {
    store.handle({
      type: 'session_event',
      sessionId: 's1',
      event: ev('turn/end', index + 2, { turn: 1, reason: { kind: 'completed' } }, { workspaceChanges: value as WorkspaceChangesSummary }),
    })
  })
  assert.equal(workspaceItems(store).length, 0, 'malformed summaries are ignored, never repaired')

  // One unusable native row rejects the whole summary instead of silently
  // re-indexing the remaining rows (index is the native diff identity).
  const malformedRows: readonly WorkspaceChangesSummary[] = [
    {
      turn: 1,
      files: [
        { path: '/a', display: 'a', added: 1, deleted: 0 },
        { path: '', display: 'broken', added: 1, deleted: 0 },
      ],
      total: 2,
      added: 1,
      deleted: 0,
    },
    {
      turn: 2,
      files: [
        { path: '/a', display: 'a', added: 1, deleted: 0 },
        { path: '/b', display: 42 as unknown as string, added: 1, deleted: 0 },
      ],
      total: 2,
      added: 1,
      deleted: 0,
    },
    {
      turn: 3,
      files: [null as unknown as WorkspaceChangeFile],
      total: 1,
      added: 1,
      deleted: 0,
    },
  ]
  malformedRows.forEach((value, index) => {
    store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(30 + index, value) })
  })
  assert.equal(workspaceItems(store).length, 0, 'a malformed native row fails the whole summary closed')
})

test('the card ignores another session and updates once while identical facts stay stable', () => {
  const store = newStore()
  const changes: number[] = []
  store.onChange = () => { changes.push(1) }
  store.handle({
    type: 'session_event',
    sessionId: 'other',
    event: liveWorkspaceEvent(7),
  })
  assert.equal(workspaceItems(store).length, 0)

  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  const first = workspaceItems(store)[0]!
  assert.equal(changes.length, 1)
  const position = store.items.findIndex(item => item.kind === 'workspace-changes')

  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  const repeated = workspaceItems(store)[0]!
  assert.equal(repeated.version, first.version, 'an identical replay does not bump the version')
  assert.equal(store.items.findIndex(item => item.kind === 'workspace-changes'), position)

  const base = summary()
  const changed: WorkspaceChangesSummary = { ...base, added: base.added + 1 }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7, changed) })
  const updated = workspaceItems(store)[0]!
  assert.equal(updated.version, first.version + 1, 'a changed native summary updates the same item in place')
  assert.equal(store.items.findIndex(item => item.kind === 'workspace-changes'), position)
  assert.equal(updated.added, first.added + 1)
})

// ---------------------------------------------------------------------------
// Card rendering

test('the card shows only native turn/count/totals and per-file facts', () => {
  const { block } = blockFor()
  const text = plain(block.render(90))
  assert.match(text, /Workspace changes/)
  assert.match(text, /turn 3/)
  assert.match(text, /4 files/)
  assert.match(text, /\+1014/)
  assert.match(text, /-4/)
  assert.match(text, /src\/greet\.ts.*\+12 -3/)
  assert.match(text, /assets\/logo\.png.*binary/)
  assert.match(text, /big\.json.*oversized/)
  assert.match(text, /src\/组件\/✅\.ts/)
  // Only the display label crosses the UI boundary: no host path, cwd or
  // snapshot identity leaks through the card.
  assert.doesNotMatch(text, /private\/repo/)
  assert.doesNotMatch(text, /tmp\/work/)
  assert.doesNotMatch(text, /snapshot/)
})

test('the card is width-safe for CJK, emoji, ANSI and tiny terminals', () => {
  const base = summary()
  const hostile: WorkspaceChangesSummary = {
    ...base,
    files: [
      {
        path: '/host/.hidden',
        display: '\x1b[31m非常长/emoji-✅\x1b[0m'.repeat(6),
        added: 12,
        deleted: 3,
      },
      ...base.files.slice(1),
    ],
  }
  const { block } = blockFor(hostile, {
    onWorkspaceChangesDetails: () => {},
    workspaceChangesDetailsHint: 'click a file for the native diff',
  })
  for (const width of [1, 2, 4, 8, 16, 24, 40, 60, 90]) {
    const lines = block.render(width)
    assert.ok(lines.length > 0, `width ${width}: the card paints something`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(stripTerminalSequences(line))}`)
      assert.doesNotMatch(stripTerminalSequences(line), /\x1b/)
    }
  }
})

test('native bounded file counts are stated honestly', () => {
  const bounded: WorkspaceChangesSummary = {
    turn: 5,
    files: [{ path: '/a', display: 'a.ts', added: 1, deleted: 1 }],
    total: 9,
    added: 4,
    deleted: 2,
  }
  assert.equal(workspaceFileCountLabel(bounded), '1 of 9 files')
  assert.equal(workspaceFileCountLabel(summary()), '4 files')
  const { block } = blockFor(bounded)
  assert.match(plain(block.render(80)), /1 of 9 files/)
})

test('file suffix helpers label binary and oversized instead of fake line counts', () => {
  assert.equal(workspaceFileNotes({ path: '/a', display: 'a', added: 0, deleted: 0, binary: true }), 'binary')
  assert.equal(workspaceFileNotes({ path: '/a', display: 'a', added: 5, deleted: 1, oversized: true }), 'oversized')
  assert.equal(
    workspaceFileSuffix({ path: '/a', display: 'a', added: 5, deleted: 1 }),
    '+5 -1',
  )
  assert.equal(workspaceFileSuffix({ path: '/a', display: 'a', added: 5, deleted: 1, binary: true }), 'binary')
})

// ---------------------------------------------------------------------------
// Cache, hover and mouse ownership

test('an unchanged repaint reuses the exact card lines and hover invalidates once', () => {
  const { block } = blockFor(summary(), { onWorkspaceChangesDetails: () => {}, screen: 'fullscreen' })
  resetCacheKeyBuilds()
  const first = block.render(80)
  assert.equal(cacheKeyBuilds(), 1, 'the first paint composes exactly one key')
  const second = block.render(80)
  assert.equal(second, first, 'an unchanged repaint reuses the exact lines array')
  assert.equal(cacheKeyBuilds(), 1)

  const fileBox = block.hitboxes().find(box => box.id.endsWith(':file:0'))
  assert.ok(fileBox !== undefined)
  assert.ok(fileBox.onHover !== undefined)
  fileBox.onHover?.(true)
  const hovered = block.render(80)
  assert.equal(cacheKeyBuilds(), 2, 'hover is a key input and drops the fast path')
  assert.notEqual(hovered.join('\n'), first.join('\n'), 'the hovered link paints a different frame')
  fileBox.onHover?.(false)
  const exited = block.render(80)
  assert.equal(cacheKeyBuilds(), 3)
  assert.equal(exited.join('\n'), first.join('\n'), 'the neutral frame returns after hover exit')

  block.invalidate()
  block.render(80)
  assert.equal(cacheKeyBuilds(), 4, 'an explicit invalidation repaints')
  const after = block.render(80)
  assert.equal(cacheKeyBuilds(), 4, 'and the fast path returns')
  assert.equal(plain(after), plain(first))
})

test('a new item version repaints; a same-version update is inert', () => {
  const { block, item } = blockFor()
  resetCacheKeyBuilds()
  const first = block.render(80)
  block.update({ ...item, version: 1, added: 999 })
  assert.equal(block.render(80), first, 'same version data is ignored')
  block.update({ ...item, version: 2, added: 999 })
  const second = block.render(80)
  assert.equal(cacheKeyBuilds(), 2)
  assert.match(plain(second), /\+999/)
})

test('file rows and the header own precise, pinned click targets', () => {
  const seen: WorkspaceChangesDetailsRequest[] = []
  const { block } = blockFor(summary(), { onWorkspaceChangesDetails: request => seen.push(request) })
  block.render(80)
  const boxes = block.hitboxes()
  assert.equal(boxes.length, 5, 'one header plus four native file rows')
  const fileOne = boxes.find(box => box.id.endsWith(':file:1'))
  assert.ok(fileOne !== undefined)
  assert.equal(fileOne.startRow, 2)
  assert.equal(fileOne.claimPress, true)

  // A press claims the row; a click after an in-place repaint still opens the
  // pressed native index.
  assert.equal(block.handleMouse(mouse('press', fileOne.startRow))?.handled, true)
  block.invalidate()
  block.render(80)
  block.handleMouse(mouse('click', fileOne.startRow))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.seq, 7)
  assert.equal(seen[0]?.index, 1)
  assert.equal(seen[0]?.files[1]?.display, 'assets/logo.png')

  const header = boxes.find(box => box.id.endsWith(':header'))
  assert.ok(header !== undefined)
  block.handleMouse(mouse('press', header.startRow))
  block.handleMouse(mouse('click', header.startRow))
  assert.equal(seen.length, 2)
  assert.equal(seen[1]?.index, undefined, 'the header opens the list, not a guessed file')
})

test('without a details callback every row stays inert', () => {
  const { block } = blockFor()
  block.render(80)
  assert.equal(block.hitboxes().length, 0)
  assert.equal(block.handleMouse(mouse('click', 1)), undefined)
})

// ---------------------------------------------------------------------------
// Transcript view: grouping, projection cache, session reset

test('the card breaks tool runs instead of being folded into a tool or status group', () => {
  // Replay the ordered events through the LIVE frame plane: the summary is a
  // live-only attachment, so `reset` would (correctly) ignore it.
  const store = newStore()
  const events = [
    ev('user/message', 1, user('go'), { surfaceOp: 'append' }),
    ev('assistant/message', 2, assistantWithCalls(['a', 'b']), { surfaceOp: 'append' }),
    ev('tool/call', 3, { turn: 1, step: 1, callId: 'a', name: 'bash', arguments: '{"command":"echo a"}' }),
    ev('tool/call', 4, { turn: 1, step: 1, callId: 'b', name: 'bash', arguments: '{"command":"echo b"}' }),
    liveWorkspaceEvent(5),
    ev('assistant/message', 6, assistantWithCalls(['c', 'd']), { surfaceOp: 'append' }),
    ev('tool/call', 7, { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"echo c"}' }),
    ev('tool/call', 8, { turn: 1, step: 1, callId: 'd', name: 'bash', arguments: '{"command":"echo d"}' }),
  ]
  for (const event of events) store.handle({ type: 'session_event', sessionId: 's1', event })
  const view = new TranscriptView(store, { showThinking: false, expandTools: false, screen: 'fullscreen' })
  view.render(80)
  const rows = view.rowSpans.map(span => span.itemId)
  assert.ok(rows.includes('workspace-changes:turn:3'), 'the changed-files card keeps its own row')
  assert.ok(rows.includes('tool:a'), 'the two calls before the card still form their own group')
  assert.ok(rows.includes('tool:c'), 'the two calls after the card form a second group')
  // The card is not a tool member: it owns exactly one row span and no group
  // header claims its id.
  assert.equal(rows.filter(id => id === 'workspace-changes:turn:3').length, 1)
  const text = plain(view.render(80))
  assert.match(text, /Workspace changes/)
  assert.match(text, /turn 3/)
  view.dispose()
})

test('view projection caching reuses the plan and the card frame until a native update', () => {
  const store = newStore()
  const view = new TranscriptView(store, { showThinking: false, expandTools: false, screen: 'fullscreen' })
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  const first = view.render(80)
  const builds = view.projectionBuilds
  const second = view.render(80)
  assert.equal(view.projectionBuilds, builds, 'an unchanged repaint reuses the plan')
  assert.equal(plain(second), plain(first))
  assert.equal(view.cachedItemCount, 1)

  const changed: WorkspaceChangesSummary = { ...summary(), added: 2000 }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7, changed) })
  assert.equal(view.projectionBuilds, builds, 'the item order did not change, so the plan is still reusable')
  const third = view.render(80)
  assert.match(plain(third), /\+2000/)
  assert.doesNotMatch(plain(third), /\+1014/)
  view.dispose()
})

test('session reset clears the card, its cache and the view is inert after dispose', () => {
  const store = newStore()
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: () => {},
  })
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  view.render(80)
  assert.equal(view.cachedItemCount, 1)
  assert.deepEqual(view.rowSpans.map(span => span.itemId), ['workspace-changes:turn:3'])

  store.reset({
    ...info(),
    sessionId: 's2',
  })
  assert.deepEqual(view.render(80), [])
  assert.equal(view.cachedItemCount, 0, 'a session switch drops the cached card')

  // A late live event for the old session is ignored by the store.
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(9) })
  assert.equal(workspaceItems(store).length, 0)

  store.handle({ type: 'session_event', sessionId: 's2', event: liveWorkspaceEvent(10) })
  assert.match(plain(view.render(80)), /Workspace changes/)
  view.dispose()
  assert.deepEqual(view.render(80), [], 'a disposed view paints nothing')
})
// ---------------------------------------------------------------------------
// R1: exact origin identity and stale-gesture inertness

const infoWithAttachment = (events: SessionEvent[] = [], attachmentId = 'attach-1'): SessionInfo => ({
  ...info(events),
  attachmentId,
})

test('the card and its request carry the exact live session/attachment origin', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(infoWithAttachment())
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  const card = workspaceItems(store)[0]!
  assert.equal(card.sessionId, 's1')
  assert.equal(card.attachmentId, 'attach-1')

  const seen: WorkspaceChangesDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: request => seen.push(request),
  })
  view.render(80)
  const span = view.rowSpans.find(entry => entry.itemId === card.id)
  assert.ok(span !== undefined)
  // Row 1 is the first native file row.
  const base = { width: 80, height: 40, button: 'left' as const, x: 4, screenX: 4, shift: false, alt: false, ctrl: false }
  view.handleMouse({ ...base, type: 'press', y: span.startRow + 1, screenY: span.startRow + 1 } as TuiMouseEvent)
  view.handleMouse({ ...base, type: 'click', y: span.startRow + 1, screenY: span.startRow + 1, clickCount: 1 } as TuiMouseEvent)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.sessionId, 's1', 'the request carries the session the card was observed in')
  assert.equal(seen[0]?.attachmentId, 'attach-1')
  assert.equal(seen[0]?.seq, 7)
  assert.equal(seen[0]?.index, 0)
  assert.equal(seen[0]?.files[0]?.path, '/private/repo/src/greet.ts')
  view.dispose()
})

test('a press pinned before store.reset is inert even before the next paint', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(infoWithAttachment())
  const seen: WorkspaceChangesDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: request => seen.push(request),
  })
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  view.render(80)
  const span = view.rowSpans.find(entry => entry.itemId === 'workspace-changes:turn:3')
  assert.ok(span !== undefined)
  const base = { width: 80, height: 40, button: 'left' as const, x: 4, screenX: 4, shift: false, alt: false, ctrl: false }
  view.handleMouse({ ...base, type: 'press', y: span.startRow + 1, screenY: span.startRow + 1 } as TuiMouseEvent)

  // Parent switches the live attachment: the store resets, no paint happens.
  store.reset({ ...infoWithAttachment([], 'attach-2'), sessionId: 's2' })
  store.handle({ type: 'session_event', sessionId: 's2', event: liveWorkspaceEvent(9) })
  // Simulate the parent forgetting to repaint: the old row span is still there.
  assert.deepEqual(view.rowSpans.map(entry => entry.itemId), ['workspace-changes:turn:3'])
  assert.equal(workspaceItems(store)[0]?.sessionId, 's2')
  view.handleMouse({ ...base, type: 'click', y: span.startRow + 1, screenY: span.startRow + 1, clickCount: 1 } as TuiMouseEvent)
  assert.equal(seen.length, 0, 'a stale pinned press can never deliver the previous session card')
  view.dispose()
})

test('retirePointerTargets synchronously drops spans, hover and pins without touching content', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(infoWithAttachment())
  const seen: WorkspaceChangesDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: request => seen.push(request),
  })
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  view.render(80)
  const before = store.items
  const span = view.rowSpans.find(entry => entry.itemId === 'workspace-changes:turn:3')
  assert.ok(span !== undefined)
  const base = { width: 80, height: 40, button: 'left' as const, x: 4, screenX: 4, shift: false, alt: false, ctrl: false }
  view.handleMouse({ ...base, type: 'press', y: span.startRow + 1, screenY: span.startRow + 1 } as TuiMouseEvent)
  assert.deepEqual(view.rowSpans.length, 1)

  view.retirePointerTargets()
  assert.equal(view.rowSpans.length, 0, 'row spans are retired before any paint')
  assert.equal(view.handleMouse({ ...base, type: 'click', y: span.startRow + 1, screenY: span.startRow + 1, clickCount: 1 } as TuiMouseEvent), undefined)
  assert.equal(seen.length, 0, 'the retired pin can no longer deliver a request')
  assert.equal(store.items, before, 'the store projection is untouched')
  assert.match(plain(view.render(80)), /Workspace changes/, 'the next paint restores the card content')
  assert.deepEqual(view.rowSpans.map(entry => entry.itemId), ['workspace-changes:turn:3'])
  view.dispose()
})

test('a same-session replaced summary is inert until the next paint', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(infoWithAttachment())
  const seen: WorkspaceChangesDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: request => seen.push(request),
  })
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  view.render(80)
  const span = view.rowSpans.find(entry => entry.itemId === 'workspace-changes:turn:3')
  assert.ok(span !== undefined)
  const base = { width: 80, height: 40, button: 'left' as const, x: 4, screenX: 4, shift: false, alt: false, ctrl: false }
  view.handleMouse({ ...base, type: 'press', y: span.startRow + 1, screenY: span.startRow + 1 } as TuiMouseEvent)

  // The native recorder writes the same turn again with a higher position.
  const replaced: WorkspaceChangesSummary = {
    turn: 3,
    files: [{ path: '/replaced', display: 'replaced.ts', added: 9, deleted: 1 }],
    total: 1,
    added: 9,
    deleted: 1,
  }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(12, replaced) })
  view.handleMouse({ ...base, type: 'click', y: span.startRow + 1, screenY: span.startRow + 1, clickCount: 1 } as TuiMouseEvent)
  assert.equal(seen.length, 0, 'the superseded summary cannot deliver an old position')

  view.render(80)
  view.handleMouse({ ...base, type: 'press', y: span.startRow + 1, screenY: span.startRow + 1 } as TuiMouseEvent)
  view.handleMouse({ ...base, type: 'click', y: span.startRow + 1, screenY: span.startRow + 1, clickCount: 1 } as TuiMouseEvent)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.seq, 12, 'the replaced card asks for the latest native position')
  assert.equal(seen[0]?.files[0]?.path, '/replaced')
  view.dispose()
})

test('a pinned workspace press cannot rebind after the stable turn card repaints a changed summary', () => {
  for (const variant of ['new-seq-new-file', 'new-seq-same-file', 'same-seq-new-file'] as const) {
    const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
    store.reset(infoWithAttachment())
    const seen: WorkspaceChangesDetailsRequest[] = []
    const view = new TranscriptView(store, flags({ onWorkspaceChangesDetails: request => seen.push(request) }))
    try {
      const before: WorkspaceChangesSummary = { turn: 3, files: [{ path: 'old.txt', display: 'old.txt', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 }
      store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7, before) })
      view.render(80)
      const span = view.rowSpans.find(span => span.itemId === 'workspace-changes:turn:3')
      assert.ok(span)
      const row = span.startRow + 1
      view.handleMouse(mouse('press', row))
      const nextSeq = variant === 'same-seq-new-file' ? 7 : 12
      const path = variant === 'new-seq-same-file' ? 'old.txt' : 'new.txt'
      const after: WorkspaceChangesSummary = { ...before, files: [{ path, display: path, added: 2, deleted: 0 }], added: 2 }
      store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(nextSeq, after) })
      view.render(80) // reuses the stable block and row, but changes native identity
      view.handleMouse(mouse('click', row))
      assert.equal(seen.length, 0, `${variant}: the old claimed press is retired, not redirected to the new summary`)
      view.handleMouse(mouse('press', row))
      view.handleMouse(mouse('click', row))
      assert.equal(seen.length, 1, `${variant}: a fresh gesture remains available`)
      assert.equal(seen[0]?.seq, nextSeq)
      assert.equal(seen[0]?.files[0]?.path, path)
    } finally { view.dispose() }
  }
})

// ---------------------------------------------------------------------------
// R3: one live card per native turn

test('one native turn keeps one card: latest record wins, late lower positions are ignored', () => {
  const store = newStore()
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  const first = workspaceItems(store)[0]!
  assert.equal(first.id, 'workspace-changes:turn:3')
  assert.equal(first.seq, 7)
  const position = store.items.findIndex(item => item.kind === 'workspace-changes')

  // The native recorder's second record for the SAME turn (e.g. `stopping()`
  // then `end()`) replaces the earlier summary in place.
  const second: WorkspaceChangesSummary = { ...summary(), added: 9, deleted: 0 }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(12, second) })
  const cards = workspaceItems(store)
  assert.equal(cards.length, 1, 'a turn never keeps two cards')
  assert.equal(cards[0]?.id, first.id, 'the card id is the turn, not the announcing seq')
  assert.equal(cards[0]?.seq, 12)
  assert.equal(cards[0]?.added, 9)
  assert.equal(cards[0]?.version, first.version + 1)
  assert.equal(store.items.findIndex(item => item.kind === 'workspace-changes'), position)

  // A late lower announcing position of the same turn cannot restore the
  // superseded summary (or its diff position).
  const late: WorkspaceChangesSummary = { ...summary(), added: 3 }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(8, late) })
  assert.equal(workspaceItems(store)[0]?.seq, 12)
  assert.equal(workspaceItems(store)[0]?.added, 9)
  assert.equal(workspaceItems(store)[0]?.version, first.version + 1)

  // Identical facts at the same position are a no-op.
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(12, second) })
  assert.equal(workspaceItems(store)[0]?.version, first.version + 1)
  assert.equal(workspaceItems(store).length, 1)

  // Same position with changed facts still updates once.
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(12, { ...second, added: 10 }) })
  assert.equal(workspaceItems(store)[0]?.version, first.version + 2)
})

test('the latest zero-files summary is a native fact, not an invented empty card', () => {
  const store = newStore()
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7) })
  const empty: WorkspaceChangesSummary = { turn: 3, files: [], total: 0, added: 0, deleted: 0 }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(12, empty) })
  const cards = workspaceItems(store)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]?.id, 'workspace-changes:turn:3')
  assert.equal(cards[0]?.seq, 12)
  assert.deepEqual(cards[0]?.files, [])
  assert.equal(cards[0]?.total, 0)

  // The card paints the native zero facts, and owns no file hitbox.
  const seen: WorkspaceChangesDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: request => seen.push(request),
  })
  const lines = plain(view.render(80))
  assert.match(lines, /Workspace changes/)
  assert.match(lines, /0 files/)
  assert.match(lines, /\+0 · -0/)
  view.dispose()
})

// ---------------------------------------------------------------------------
// R2: native order/index, whitespace labels

test('whitespace-only native labels keep their order and native index', () => {
  const store = newStore()
  const native: WorkspaceChangesSummary = {
    turn: 1,
    files: [
      { path: ' ', display: ' ', added: 1, deleted: 0 },
      { path: 'a.txt', display: 'a.txt', added: 2, deleted: 1 },
    ],
    total: 2,
    added: 3,
    deleted: 1,
  }
  store.handle({ type: 'session_event', sessionId: 's1', event: liveWorkspaceEvent(7, native) })
  const card = workspaceItems(store)[0]!
  assert.deepEqual(card.files.map(file => file.display), [' ', 'a.txt'], 'native order and length are preserved')
  assert.deepEqual(card.files.map(file => file.path), [' ', 'a.txt'], 'the native path is retained verbatim')
  assert.equal(card.total, 2)

  const seen: WorkspaceChangesDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false,
    expandTools: false,
    screen: 'fullscreen',
    onWorkspaceChangesDetails: request => seen.push(request),
  })
  const text = plain(view.render(80))
  // The whitespace label is visible (quoted), not a blank row.
  assert.match(text, /' '/)
  assert.match(text, /a\.txt/)
  const span = view.rowSpans.find(entry => entry.itemId === 'workspace-changes:turn:1')
  assert.ok(span !== undefined)
  const base = { width: 80, height: 40, button: 'left' as const, x: 4, screenX: 4, shift: false, alt: false, ctrl: false }
  // Native index 0 is the whitespace file, and its own path is what is asked for.
  view.handleMouse({ ...base, type: 'press', y: span.startRow + 1, screenY: span.startRow + 1 } as TuiMouseEvent)
  view.handleMouse({ ...base, type: 'click', y: span.startRow + 1, screenY: span.startRow + 1, clickCount: 1 } as TuiMouseEvent)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.index, 0)
  assert.equal(seen[0]?.files[0]?.path, ' ')
  view.dispose()
})
