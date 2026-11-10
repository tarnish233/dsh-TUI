// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, type TuiMouseEvent, type TuiMouseEventType } from '#pi-tui'
import type { SubagentEntry } from '../src/backend/types.ts'
import type { SubagentMessageTranscriptItem, SubagentTranscriptItem } from '../src/state/subagents.ts'
import { createItemBlock, type TranscriptViewOptions } from '../src/ui/blocks.ts'
import { cacheKeyBuilds, resetCacheKeyBuilds } from '../src/ui/render-counters.ts'
import { SubagentGroupBlock, type SubagentGroupMember, type SubagentRecordItem } from '../src/ui/subagent-group.ts'
import { t } from '../src/ui/theme.ts'
import {
  clearToolExpansion,
  isToolExpanded,
  setToolExpanded,
  toolExpansionRevision,
  toolGroupExpansionKey,
} from '../src/ui/tool-expansion.ts'

/**
 * The durable subagent group's paint cache, hover and read-only isolation.
 *
 * R9: the header hint is a paint input (accent while hovered), so both hover
 * transitions must drop the composed frame *before* the fast path can answer —
 * a repaint request alone leaves the neutral lines (or the accent) in place.
 * R4: a read-only projection neither reads nor writes the shared disclosure map,
 * so isolating a historical view can never touch the live transcript's state.
 *
 * Everything here is offline: synthetic durable items, no store, no timer, no
 * stdout and no child catalog/session read.
 */

// ---------------------------------------------------------------------------
// Fixtures

const HINT = ' · ctrl+o to expand'

const viewOptions = (extra: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions => ({
  showThinking: true,
  expandTools: false,
  groupTools: true,
  hints: { expand: 'ctrl+o' },
  screen: 'inline',
  ...extra,
})

/** Mark one projection read-only (R4 marker on `TranscriptViewOptions`). */
const readonlyProjection = (flags: TranscriptViewOptions): TranscriptViewOptions =>
  ({ ...flags, readonlyDisclosure: true })

const entry = (id: string, overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id,
  parentSessionId: 's1',
  mode: 'one-shot',
  status: 'completed',
  label: `Child ${id}`,
  catalogSeq: 2,
  ...overrides,
})

const catalogRecord = (id: string, status: SubagentEntry['status'] = 'completed', seq = 5): SubagentTranscriptItem => ({
  kind: 'subagent',
  id: `subagent:${id}`,
  seq,
  entry: entry(id, { status }),
  version: 1,
})

const noticeRecord = (seq: number, senderSessionId = 'child-2'): SubagentMessageTranscriptItem => ({
  kind: 'subagent-message',
  id: `subagent-message:${seq}`,
  seq,
  sourceKind: 'subagent-settled',
  senderSessionId,
  form: 'notice',
  summary: `Background subagent ${senderSessionId} finished.`,
  text: 'It sent you a message just before finishing.',
  version: 1,
})

const MOUSE_BASE = {
  screenX: 0,
  screenY: 0,
  width: 100,
  height: 30,
  shift: false,
  alt: false,
  ctrl: false,
} as const

function mouse(type: TuiMouseEventType, x: number, y: number): TuiMouseEvent {
  return { ...MOUSE_BASE, type, x, y, button: type === 'move' ? 'none' : 'left', screenX: x + 10, screenY: y + 3 }
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))
const text = (lines: readonly string[]): string => plain(lines).join('\n')

const reset = (): void => { clearToolExpansion() }

/**
 * A standalone group over two durable records: one catalog row plus one
 * settlement notice, both openable so the collapsed rows carry real name links.
 * `readOnly` applies the R4 marker; `requested` counts repaint requests.
 */
function standalone(options: { readOnly?: boolean; flags?: Partial<TranscriptViewOptions> } = {}): {
  readonly group: SubagentGroupBlock
  readonly members: readonly SubagentGroupMember[]
  readonly requested: () => number
} {
  let requests = 0
  const flags = viewOptions({
    onRenderRequest: () => { requests += 1 },
    onSubagentDetails: () => {},
    ...options.flags,
  })
  const projection = options.readOnly === true ? readonlyProjection(flags) : flags
  const records: SubagentRecordItem[] = [catalogRecord('child-1', 'running'), noticeRecord(6)]
  const members: SubagentGroupMember[] = records.map(item => ({ item, block: createItemBlock(item, projection) }))
  const group = new SubagentGroupBlock(records[0]!, projection)
  group.setMembers(members)
  return { group, members, requested: () => requests }
}

// ---------------------------------------------------------------------------
// R9: the header hover is a paint input of the fast path

test('R9: hovering the group header paints the accent hint instead of a stale frame', () => {
  reset()
  const { group, requested } = standalone()
  const width = 100
  resetCacheKeyBuilds()
  const rest = group.render(width)
  assert.equal(cacheKeyBuilds(), 1, 'the first paint composes exactly one key')
  assert.ok(rest[0]!.includes(t.muted(HINT)), 'the resting hint is neutral')

  // Stable, hover-free repaint: still the fast path, no key, no request.
  assert.equal(group.render(width), rest, 'a hover-free repeat reuses the exact frame')
  assert.equal(cacheKeyBuilds(), 1, 'a hover-free repeat composes no key')
  assert.equal(requested(), 0, 'a hover-free repeat asks for no repaint')

  // Enter: one real transition, one composed key, one requested paint.
  assert.equal(group.handleMouse(mouse('move', 2, 0)), undefined, 'motion is never claimed')
  assert.equal(requested(), 1, 'entering asks for exactly one repaint')
  const hovered = group.render(width)
  assert.equal(cacheKeyBuilds(), 2, 'the enter transition composes exactly one new key')
  assert.ok(hovered[0]!.includes(t.accent(HINT)), 'the hint is painted in the hover accent')
  assert.notEqual(hovered[0], rest[0], 'the header really changes')
  assert.equal(plain(hovered)[0], plain(rest)[0], 'only the styling changes, never the text')
  assert.deepEqual(hovered.slice(1), rest.slice(1), 'no member row is repainted by header hover')

  // Fast-path answer === forced rebuild, byte for byte.
  group.invalidate()
  assert.equal(group.render(width)[0], hovered[0], 'the fast-path header equals a forced rebuild')

  // A stationary pointer is not a transition.
  const settled = group.render(width)
  const builds = cacheKeyBuilds()
  assert.equal(group.handleMouse(mouse('move', 2, 0)), undefined)
  assert.equal(group.render(width), settled, 'staying on the header reuses the frame')
  assert.equal(cacheKeyBuilds(), builds, 'staying on the header composes no key')
  assert.equal(requested(), 1, 'staying on the header is not a transition')

  // Leave for a member row: the neutral frame comes back, byte for byte.
  group.handleMouse(mouse('move', 2, 2))
  assert.equal(requested(), 2, 'leaving asks for exactly one repaint')
  const left = group.render(width)
  assert.deepEqual(left, rest, 'the accent does not stick after the pointer leaves')
  assert.equal(cacheKeyBuilds(), builds + 1, 'the exit transition composes exactly one key')
  group.dispose()
})

test('R9: a frame rebuilt while the header is hovered is dropped again on leave', () => {
  reset()
  const { group, members } = standalone()
  const width = 100
  const rest = group.render(width)
  group.handleMouse(mouse('move', 2, 0))
  assert.ok(group.render(width)[0]!.includes(t.accent(HINT)), 'the hover is painted')

  // A live record update is the realistic "other invalidation": it composes a
  // fresh frame *while* the pointer still sits on the header.
  group.setMembers(members.map(member => ({ ...member, item: { ...member.item, version: member.item.version + 1 } })))
  assert.ok(group.render(width)[0]!.includes(t.accent(HINT)), 'the rebuilt frame still paints the hover')

  // Leaving must invalidate that newer frame too, not only the first one.
  group.handleMouse(mouse('move', 2, 3))
  const left = group.render(width)
  assert.ok(!left[0]!.includes(t.accent(HINT)), 'the accent is gone after leaving')
  assert.equal(plain(left)[0], plain(rest)[0], 'the neutral header is painted, not a stuck accent')

  // A member repaint (its own cache drops its key) must not resurrect it either.
  group.handleMouse(mouse('move', 2, 0))
  group.render(width)
  group.handleMouse(mouse('move', 2, 3))
  for (const member of members) member.block.invalidate()
  assert.deepEqual(group.render(width), left, 'a member repaint after leave paints the neutral header')
  group.dispose()
})

test('R9: a header press stays pinned across the hover invalidation', () => {
  reset()
  const { group } = standalone()
  const width = 100
  group.render(width)
  assert.equal(group.handleMouse(mouse('press', 2, 0))?.handled, true, 'the header claims the press')
  // The pointer leaves (dropping the hover frame) and returns before release:
  // the pinned press must still reach the region that was pressed.
  group.handleMouse(mouse('move', 2, 1))
  group.render(width)
  group.handleMouse(mouse('move', 2, 0))
  group.render(width)
  assert.equal(group.handleMouse(mouse('click', 2, 0))?.handled, true, 'the synthesized click lands')
  assert.equal(group.expanded, true, 'the pinned press still toggled its own header')
  assert.ok(text(group.render(width)).includes('Child child-1'), 'the real member paint is shown')
  reset()
  group.dispose()
})

// ---------------------------------------------------------------------------
// R4: a read-only projection is a no-touch reader of the shared map

test('R4: a read-only subagent group never reads or writes the live disclosure map', () => {
  reset()
  const key = toolGroupExpansionKey('subagent:child-1')
  setToolExpanded(key, true)
  const live = standalone()
  assert.equal(live.group.expanded, true, 'the live transcript is expanded')

  const readOnly = standalone({ readOnly: true })
  assert.equal(readOnly.group.expanded, false, 'the read-only group defaults to collapsed')
  assert.equal(isToolExpanded(key), true, 'reading the read-only frame left the live override alone')

  const revision = toolExpansionRevision()
  readOnly.group.toggle()
  assert.equal(toolExpansionRevision(), revision, 'toggle() is a no-op in a read-only projection')
  assert.equal(isToolExpanded(key), true, 'the live override survived the read-only toggle')

  const width = 100
  const lines = readOnly.group.render(width)
  assert.equal(readOnly.group.expanded, false, 'still collapsed after painting')
  assert.equal(lines.length, 1 + readOnly.members.length, 'only the collapsed frame is painted')
  assert.ok(!plain(lines)[0]!.includes('ctrl+o to expand'), 'no shortcut is advertised that cannot run')
  assert.ok(!readOnly.group.hitboxes.some(box => box.id.endsWith('#header')), 'the header is not a control')
  assert.equal(readOnly.group.handleMouse(mouse('move', 2, 0)), undefined)
  assert.equal(readOnly.group.hoverSlot, undefined, 'the read-only header owns no hover target')
  assert.equal(readOnly.group.handleMouse(mouse('press', 2, 0)), undefined, 'the read-only header claims no press')
  assert.equal(readOnly.group.handleMouse(mouse('click', 2, 0)), undefined)
  assert.equal(toolExpansionRevision(), revision, 'no click path mutated the shared map')
  assert.equal(isToolExpanded(key), true, 'the live override is still exactly as it was')

  // The live projection is unaffected by anything the read-only view painted.
  assert.equal(new SubagentGroupBlock(live.group.memberItems[0]!, viewOptions()).expanded, true)
  assert.ok(text(live.group.render(width)).includes('It sent you a message'), 'the live group is still open')
  live.group.dispose()
  readOnly.group.dispose()

  // Defaults are unchanged: a plain group with no override stays collapsed.
  reset()
  const defaultGroup = standalone()
  assert.equal(defaultGroup.group.expanded, false, 'the default disclosure is still collapsed')

  // ...and a read-only toggle over an *empty* map must not create an override
  // either (the shared helper would otherwise write one).
  const emptyRevision = toolExpansionRevision()
  const emptyReadOnly = standalone({ readOnly: true })
  emptyReadOnly.group.render(width)
  emptyReadOnly.group.toggle()
  assert.equal(isToolExpanded(key, false), false, 'no override was created')
  assert.equal(toolExpansionRevision(), emptyRevision, 'the shared generation did not move')
  emptyReadOnly.group.dispose()
  defaultGroup.group.dispose()
})