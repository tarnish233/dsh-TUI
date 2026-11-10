/** Ephemeral disclosure overrides; never persisted to a DSH session or TUI file. */
import type { ToolViewOptions } from './tool-view.ts'

/**
 * Read-only disclosure flag shared by transcript blocks.
 *
 * A view that sets `readonlyDisclosure: true` (the historical detail surface)
 * must not read, write, clear or transfer the module-level overrides: those are
 * the **live** transcript's ephemeral state, and a second view mutating them
 * would silently collapse a card the user is looking at in the main view.
 * Read-only disclosure is always collapsed and every toggle is a no-op.
 */
export interface ReadonlyDisclosureFlags {
  readonly readonlyDisclosure?: boolean
}

export function isReadonlyDisclosure(flags: ReadonlyDisclosureFlags | undefined): boolean {
  return flags?.readonlyDisclosure === true
}

const overrides = new Map<string, boolean>()
/**
 * Monotone generation of the override map.
 *
 * Disclosure is a cache-key input of every card and group but not a content
 * version, so a repaint cache that answers "nothing can have changed since this
 * paint" must still notice a flip. Each block records the generation it painted
 * with and rebuilds when it differs; the counter only moves on a real mutation
 * (`retainToolExpansion` bumps it only when it actually drops an entry), so an
 * unchanged frame with no disclosure activity never rebuilds anything.
 */
let expansionRevision = 0
export function toolExpansionRevision(): number {
  return expansionRevision
}
export const toolExpansionKey = (callId: string): string => 'tool:' + callId
export const toolGroupExpansionKey = (anchorCallId: string): string => 'group:' + anchorCallId
export function isToolExpanded(key: string, defaultExpanded = false): boolean {
  return overrides.get(key) ?? defaultExpanded
}

/**
 * Effective disclosure of one card/group key for one view.
 *
 * Read-only views bypass the module map entirely (never inherit a same-key
 * override from the live transcript) and are forced collapsed, so a historical
 * detail cannot paint or toggle a live disclosure.
 */
export function toolDisclosureExpanded(flags: ToolViewOptions & ReadonlyDisclosureFlags, key: string): boolean {
  if (isReadonlyDisclosure(flags)) return false
  return isToolExpanded(key, flags.expandTools === true)
}
export function setToolExpanded(key: string, expanded: boolean): void {
  if (overrides.get(key) === expanded) return
  overrides.set(key, expanded)
  expansionRevision += 1
}
export function clearToolExpansion(): void {
  if (overrides.size === 0) return
  overrides.clear()
  expansionRevision += 1
}
export function retainToolExpansion(keys: ReadonlySet<string>): void {
  let dropped = false
  for (const key of overrides.keys()) {
    if (keys.has(key)) continue
    overrides.delete(key)
    dropped = true
  }
  if (dropped) expansionRevision += 1
}
export interface ToolExpansionHooks extends ToolViewOptions, ReadonlyDisclosureFlags {
  onViewportAnchor?: (expanding: boolean) => void
  onRenderRequest?: () => void
}
/**
 * Run once before flipping. Standalone cards work without an App or TranscriptView.
 *
 * A read-only view returns immediately: no override, no viewport anchor and no
 * repaint is requested, so no block can mutate shared disclosure state through
 * this one seam (cards, tool groups and the mixed/subagent groups all use it).
 */
export function requestToolExpansion(options: ToolExpansionHooks, key: string, expanded: boolean): void {
  if (isReadonlyDisclosure(options)) return
  if (options.onToolExpansionRequest !== undefined) {
    options.onToolExpansionRequest(key, expanded)
    return
  }
  options.onViewportAnchor?.(expanded)
  setToolExpanded(key, expanded)
  options.onRenderRequest?.()
}
