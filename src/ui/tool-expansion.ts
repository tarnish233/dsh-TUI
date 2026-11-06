/** Ephemeral disclosure overrides; never persisted to a DSH session or TUI file. */
import type { ToolViewOptions } from './tool-view.ts'

const overrides = new Map<string, boolean>()
export const toolExpansionKey = (callId: string): string => 'tool:' + callId
export const toolGroupExpansionKey = (anchorCallId: string): string => 'group:' + anchorCallId
export function isToolExpanded(key: string, defaultExpanded = false): boolean {
  return overrides.get(key) ?? defaultExpanded
}
export function setToolExpanded(key: string, expanded: boolean): void {
  overrides.set(key, expanded)
}
export function clearToolExpansion(): void { overrides.clear() }
export function retainToolExpansion(keys: ReadonlySet<string>): void {
  for (const key of overrides.keys()) if (!keys.has(key)) overrides.delete(key)
}
export interface ToolExpansionHooks extends ToolViewOptions {
  onViewportAnchor?: (expanding: boolean) => void
  onRenderRequest?: () => void
}
/** Run once before flipping. Standalone cards work without an App or TranscriptView. */
export function requestToolExpansion(options: ToolExpansionHooks, key: string, expanded: boolean): void {
  if (options.onToolExpansionRequest !== undefined) {
    options.onToolExpansionRequest(key, expanded)
    return
  }
  options.onViewportAnchor?.(expanded)
  setToolExpanded(key, expanded)
  options.onRenderRequest?.()
}
