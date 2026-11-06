/**
 * Pure native-subagent projection for the transcript and the Agents overlay.
 *
 * DSH owns the child catalog and each child Session. This module keeps no
 * runtime state of its own, starts no timer and never invents a child:
 *
 *   SubagentProjection   idempotent fold of the shared `subagents` snapshot and
 *                        `subagent` upserts (identity = child session id)
 *   composeSubagentRows  anchors one stable transcript row per DIRECT child
 *                        that carries a trustworthy parent `catalogSeq`
 *   buildSubagentTree    parentSessionId tree for the temporary overlay
 *   readSubagentMessage  durable settlement/trigger `user/message` rows
 *
 * Anchoring rule: a `catalogSeq` is the parent log seq of a `subagent/catalog`
 * event. Only an entry whose `parentSessionId` is the projected session may be
 * anchored there; a nested child's catalog seq belongs to its own parent's log.
 * Entries without a seq (cold catalog rows, external tasks) stay available to
 * the overlay and are never inserted at a guessed transcript position.
 */
import type {
  SubagentEntry,
  SubagentMode,
  SubagentSnapshot,
  SubagentStatus,
  SubagentTiming,
} from '../backend/types.ts'
import type { TranscriptItem } from './transcript.ts'

/** Durable trigger messages DSH writes into the parent's own user role. */
export type SubagentMessageSourceKind = 'subagent-settled' | 'agent-message'

/** One anchored direct-child row in the parent transcript. */
export interface SubagentTranscriptItem {
  readonly kind: 'subagent'
  /** Stable id per child: one row, updated in place, never a second copy. */
  readonly id: string
  readonly entry: SubagentEntry
  /** Native parent catalog seq used as the anchor; never synthesized. */
  readonly seq?: number
  readonly version: number
}

/**
 * One durable settlement/trigger row. It is a real `user/message` fact, but it
 * is not a human prompt: the view renders it as native attribution plus text.
 */
export interface SubagentMessageTranscriptItem {
  readonly kind: 'subagent-message'
  readonly id: string
  readonly seq: number
  readonly sourceKind: SubagentMessageSourceKind
  readonly senderSessionId: string
  readonly summary?: string
  readonly form?: string
  /** Exact native text, preserved verbatim for consumers that need it. */
  readonly text: string
  readonly version: number
}

interface EntryState {
  readonly entry: SubagentEntry
  readonly revision: number
}

const MODES: readonly SubagentMode[] = ['one-shot', 'continuable', 'external', 'unknown']
const STATUSES: readonly SubagentStatus[] = [
  'initializing',
  'running',
  'idle',
  'completed',
  'failed',
  'stopped',
  'max-tokens',
  'refusal',
  'unknown',
  'external',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asNonNegative = (value: unknown): number | undefined => {
  const number = asNumber(value)
  return number !== undefined && number >= 0 ? number : undefined
}

const asSeq = (value: unknown): number | undefined => {
  const number = asNumber(value)
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function modeOf(value: unknown): SubagentMode {
  return MODES.includes(value as SubagentMode) ? value as SubagentMode : 'unknown'
}

function statusOf(value: unknown): SubagentStatus {
  return STATUSES.includes(value as SubagentStatus) ? value as SubagentStatus : 'unknown'
}

/** Whitelist native timing fields; absent/non-finite values stay absent. */
function timingOf(value: unknown): SubagentTiming | undefined {
  if (!isRecord(value)) return undefined
  const timing: {
    settledMs?: number
    activeSince?: number
    activeThrough?: number
    lastTurnCompleted?: boolean
  } = {}
  const settledMs = asNonNegative(value.settledMs)
  if (settledMs !== undefined) timing.settledMs = settledMs
  const activeSince = asNumber(value.activeSince)
  if (activeSince !== undefined && activeSince >= 0) timing.activeSince = activeSince
  const activeThrough = asNumber(value.activeThrough)
  if (activeThrough !== undefined && activeThrough >= 0) timing.activeThrough = activeThrough
  if (typeof value.lastTurnCompleted === 'boolean') timing.lastTurnCompleted = value.lastTurnCompleted
  return Object.keys(timing).length === 0 ? undefined : timing
}

function sameTiming(left: SubagentTiming | undefined, right: SubagentTiming | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.settledMs === right.settledMs &&
    left.activeSince === right.activeSince &&
    left.activeThrough === right.activeThrough &&
    left.lastTurnCompleted === right.lastTurnCompleted
}

/**
 * Normalize a typed-but-untrusted entry. `fallback` supplies identity/anchor
 * fields a live upsert may omit after a cold snapshot already established them;
 * it never invents a seq for a child that had none.
 */
export function normalizeSubagentEntry(value: unknown, fallback?: SubagentEntry): SubagentEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id) ?? fallback?.id
  const parentSessionId = asString(value.parentSessionId) ?? fallback?.parentSessionId
  if (id === undefined || parentSessionId === undefined) return undefined
  const entry: {
    id: string
    parentSessionId: string
    catalogSeq?: number
    createdAt?: number
    mode: SubagentMode
    label?: string
    provider?: string
    model?: string
    reasoningEffort?: string
    local?: boolean
    status: SubagentStatus
    lastActivity?: string
    lastRunId?: string
    lastStopReason?: string
    totalTokens?: number
    timing?: SubagentTiming
  } = {
    id,
    parentSessionId,
    mode: modeWithFallback(value.mode, fallback),
    status: statusOf(value.status ?? fallback?.status),
  }
  const catalogSeq = asSeq(value.catalogSeq) ?? fallback?.catalogSeq
  if (catalogSeq !== undefined) entry.catalogSeq = catalogSeq
  const createdAt = asNumber(value.createdAt) ?? fallback?.createdAt
  if (createdAt !== undefined) entry.createdAt = createdAt
  const label = asString(value.label) ?? fallback?.label
  if (label !== undefined) entry.label = label
  const provider = asString(value.provider) ?? fallback?.provider
  if (provider !== undefined) entry.provider = provider
  const model = asString(value.model) ?? fallback?.model
  if (model !== undefined) entry.model = model
  const effort = asString(value.reasoningEffort) ?? fallback?.reasoningEffort
  if (effort !== undefined) entry.reasoningEffort = effort
  const local = typeof value.local === 'boolean' ? value.local : fallback?.local
  if (local !== undefined) entry.local = local
  const lastActivity = asString(value.lastActivity) ?? fallback?.lastActivity
  if (lastActivity !== undefined) entry.lastActivity = lastActivity
  const lastRunId = asString(value.lastRunId) ?? fallback?.lastRunId
  if (lastRunId !== undefined) entry.lastRunId = lastRunId
  const lastStopReason = asString(value.lastStopReason) ?? fallback?.lastStopReason
  if (lastStopReason !== undefined) entry.lastStopReason = lastStopReason
  const totalTokens = asNonNegative(value.totalTokens) ?? fallback?.totalTokens
  if (totalTokens !== undefined) entry.totalTokens = totalTokens
  const timing = timingOf(value.timing) ?? (value.timing === undefined ? fallback?.timing : undefined)
  if (timing !== undefined) entry.timing = timing
  return Object.freeze(entry)
}

function modeWithFallback(value: unknown, fallback: SubagentEntry | undefined): SubagentMode {
  if (MODES.includes(value as SubagentMode)) return value as SubagentMode
  return fallback?.mode ?? 'unknown'
}

export function sameSubagentEntry(left: SubagentEntry, right: SubagentEntry): boolean {
  return left.id === right.id &&
    left.parentSessionId === right.parentSessionId &&
    left.catalogSeq === right.catalogSeq &&
    left.createdAt === right.createdAt &&
    left.mode === right.mode &&
    left.label === right.label &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.local === right.local &&
    left.status === right.status &&
    left.lastActivity === right.lastActivity &&
    left.lastRunId === right.lastRunId &&
    left.lastStopReason === right.lastStopReason &&
    left.totalTokens === right.totalTokens &&
    sameTiming(left.timing, right.timing)
}

/** Stable order: native seq first, then creation time, then identity. */
function compareEntries(left: SubagentEntry, right: SubagentEntry): number {
  const leftSeq = left.catalogSeq ?? Number.MAX_SAFE_INTEGER
  const rightSeq = right.catalogSeq ?? Number.MAX_SAFE_INTEGER
  if (leftSeq !== rightSeq) return leftSeq - rightSeq
  const leftCreated = left.createdAt ?? 0
  const rightCreated = right.createdAt ?? 0
  if (leftCreated !== rightCreated) return leftCreated - rightCreated
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Idempotent native catalog fold.
 *
 * `applySnapshot` is authoritative for membership (removed children disappear),
 * while `applyEntry` merges one live upsert over the known row so a later
 * status/activity frame cannot erase the cold catalog anchor. Equal data is a
 * no-op and keeps the previous object/revision, so a replayed catalog never
 * re-renders or re-keys a stable row.
 */
export class SubagentProjection {
  private readonly states = new Map<string, EntryState>()
  private revisionCounter = 0
  private truncatedValue = false
  private knownSnapshot = false

  /** Number of accepted catalog mutations (diagnostics/tests). */
  get revision(): number {
    return this.revisionCounter
  }

  get truncated(): boolean {
    return this.truncatedValue
  }

  get size(): number {
    return this.states.size
  }

  /** Every known child, direct or nested, in stable native order. */
  get entries(): readonly SubagentEntry[] {
    return [...this.states.values()].map(state => state.entry).sort(compareEntries)
  }

  /** Rows that can be anchored in THIS parent transcript. */
  anchoredFor(parentSessionId: string | undefined): readonly EntryState[] {
    if (parentSessionId === undefined) return []
    return [...this.states.values()]
      .filter(state => state.entry.parentSessionId === parentSessionId && state.entry.catalogSeq !== undefined)
      .sort((left, right) => compareEntries(left.entry, right.entry))
  }

  get(id: string | undefined): SubagentEntry | undefined {
    return id === undefined ? undefined : this.states.get(id)?.entry
  }

  revisionOf(id: string): number {
    return this.states.get(id)?.revision ?? 0
  }

  /** The current serializable snapshot; absent before any native catalog read. */
  get snapshot(): SubagentSnapshot | undefined {
    if (!this.knownSnapshot) return undefined
    return {
      entries: this.entries,
      ...(this.truncatedValue ? { truncated: true } : {}),
    }
  }

  /** Replace membership from a native full snapshot (idempotent). */
  applySnapshot(value: SubagentSnapshot | undefined): boolean {
    const wasKnown = this.knownSnapshot
    const truncated = value?.truncated === true
    const truncatedChanged = !wasKnown || this.truncatedValue !== truncated
    this.knownSnapshot = true
    this.truncatedValue = truncated
    if (value === undefined) return this.replaceAll([]) || truncatedChanged
    const rows = Array.isArray(value.entries) ? value.entries : []
    return this.replaceAll(rows) || truncatedChanged
  }

  /** Apply one live upsert, preserving a known cold snapshot anchor. */
  applyEntry(value: unknown): boolean {
    const existing = isRecord(value) && typeof value.id === 'string' ? this.states.get(value.id) : undefined
    const entry = normalizeSubagentEntry(value, existing?.entry)
    if (entry === undefined) return false
    // A native upsert is itself catalog evidence; a live-only stream can still
    // hand the parent a current snapshot.
    this.knownSnapshot = true
    if (existing !== undefined && sameSubagentEntry(existing.entry, entry)) return false
    this.states.set(entry.id, { entry, revision: ++this.revisionCounter })
    return true
  }

  clear(): boolean {
    this.knownSnapshot = false
    this.truncatedValue = false
    if (this.states.size === 0) return false
    this.states.clear()
    this.revisionCounter += 1
    return true
  }

  private replaceAll(rows: readonly unknown[]): boolean {
    const next = new Map<string, SubagentEntry>()
    for (const row of rows) {
      const entry = normalizeSubagentEntry(row)
      if (entry === undefined) continue
      // Later duplicates in one snapshot win, matching a fold of the same list.
      next.set(entry.id, entry)
    }
    let changed = next.size !== this.states.size
    for (const [id, entry] of next) {
      const previous = this.states.get(id)
      if (previous === undefined || !sameSubagentEntry(previous.entry, entry)) {
        changed = true
        this.states.set(id, { entry, revision: ++this.revisionCounter })
      }
    }
    for (const id of [...this.states.keys()]) {
      if (!next.has(id)) {
        this.states.delete(id)
      }
    }
    return changed
  }
}

/**
 * Insert anchored direct-child rows into an ordered transcript.
 *
 * Placement is the last projected item whose native seq is <= `catalogSeq`; a
 * seq beyond the current durable window lands at the durable tail rather than
 * inventing a future position, and a seq below every item lands first. The base
 * array is never mutated. Entries without a seq (or belonging to another
 * parent's log) are omitted: they remain available to the overlay.
 */
export function composeSubagentRows(
  items: readonly TranscriptItem[],
  projection: SubagentProjection,
  parentSessionId: string | undefined,
): readonly TranscriptItem[] {
  const anchored = projection.anchoredFor(parentSessionId)
  if (anchored.length === 0) return items
  const out: TranscriptItem[] = [...items]
  for (const state of anchored) {
    const entry = state.entry
    const seq = entry.catalogSeq
    if (seq === undefined) continue
    const index = anchorIndex(out, seq)
    out.splice(index, 0, {
      kind: 'subagent',
      id: `subagent:${entry.id}`,
      entry,
      seq,
      version: state.revision,
    })
  }
  return out
}

function itemSeq(item: TranscriptItem): number | undefined {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'tool':
    case 'attempt':
    case 'subagent-message':
    case 'subagent':
      return item.seq
    case 'notice':
    case 'todos':
      return undefined
  }
}

function anchorIndex(items: readonly TranscriptItem[], seq: number): number {
  let last = -1
  for (let index = 0; index < items.length; index += 1) {
    const eventSeq = itemSeq(items[index]!)
    if (eventSeq !== undefined && eventSeq <= seq) last = index
  }
  return last + 1
}

// ---------------------------------------------------------------------------
// Agents overlay tree

export interface SubagentTreeNode {
  readonly entry: SubagentEntry
  readonly depth: number
  /** External tasks have no local child Session to open. */
  readonly external: boolean
  readonly children: readonly SubagentTreeNode[]
}

/**
 * Project a `parentSessionId` forest, sorted by native catalog order at every
 * level. A child whose parent is not present becomes a root instead of
 * disappearing; cycles are broken at the repeated id and the orphan is kept as
 * a root, so malformed data can never hide a real row.
 */
export function buildSubagentTree(entries: readonly SubagentEntry[]): readonly SubagentTreeNode[] {
  const byId = new Map<string, SubagentEntry>()
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry)
  const childrenOf = new Map<string, SubagentEntry[]>()
  for (const entry of byId.values()) {
    const siblings = childrenOf.get(entry.parentSessionId)
    if (siblings === undefined) childrenOf.set(entry.parentSessionId, [entry])
    else siblings.push(entry)
  }
  for (const siblings of childrenOf.values()) siblings.sort(compareEntries)

  const visited = new Set<string>()
  const build = (entry: SubagentEntry, depth: number): SubagentTreeNode => {
    visited.add(entry.id)
    const external = entry.mode === 'external' || entry.status === 'external'
    const children: SubagentTreeNode[] = []
    if (!external) {
      for (const child of childrenOf.get(entry.id) ?? []) {
        if (visited.has(child.id)) continue
        children.push(build(child, depth + 1))
      }
    }
    return { entry, depth, external, children }
  }

  const roots: SubagentTreeNode[] = []
  const rootRows = [...byId.values()]
    .filter(entry => !byId.has(entry.parentSessionId))
    .sort(compareEntries)
  for (const root of rootRows) {
    if (visited.has(root.id)) continue
    roots.push(build(root, 0))
  }
  // Orphans left by a cycle are still real children: show them at root level.
  for (const entry of [...byId.values()].sort(compareEntries)) {
    if (visited.has(entry.id)) continue
    roots.push(build(entry, 0))
  }
  return roots
}

/** Flatten a tree in display order (the overlay's list navigation unit). */
export function flattenSubagentTree(roots: readonly SubagentTreeNode[]): SubagentTreeNode[] {
  const out: SubagentTreeNode[] = []
  const walk = (nodes: readonly SubagentTreeNode[]): void => {
    for (const node of nodes) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(roots)
  return out
}

// ---------------------------------------------------------------------------
// Durable settlement / trigger messages

export interface SubagentMessageFields {
  readonly sourceKind: SubagentMessageSourceKind
  readonly senderSessionId: string
  readonly summary?: string
  readonly form?: string
  readonly text: string
}

/**
 * Read DSH's two attributed non-human `user/message` sources without turning
 * them into prompts or notices. Content stays in native order; the joined text
 * is the exact display text (blocks joined with a blank line, same rule as the
 * human message projection). A missing identity is not guessed.
 */
export function readSubagentMessage(data: unknown): SubagentMessageFields | undefined {
  if (!isRecord(data)) return undefined
  const source = isRecord(data.source) ? data.source : undefined
  if (source === undefined) return undefined
  const kind = source.kind
  if (kind !== 'subagent-settled' && kind !== 'agent-message') return undefined
  const senderSessionId = asString(source.senderSessionId)
  if (senderSessionId === undefined) return undefined
  const summary = asString(source.summary)
  const form = asString(source.form)
  const texts: string[] = []
  for (const block of Array.isArray(data.content) ? data.content : []) {
    if (!isRecord(block) || block.type !== 'text') continue
    if (typeof block.text === 'string') texts.push(block.text)
  }
  return {
    sourceKind: kind,
    senderSessionId,
    ...(summary === undefined ? {} : { summary }),
    ...(form === undefined ? {} : { form }),
    text: texts.join('\n\n'),
  }
}