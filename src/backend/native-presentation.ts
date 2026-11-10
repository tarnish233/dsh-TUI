/**
 * Validation of native tool-call render intents for an approval preview.
 *
 * DSH tools declare `presentCall(args): ToolCallView | undefined` — a pure,
 * side-effect-free projection of the call arguments (`@deepseek-ai/dsh-tools`
 * presentation contract). The backend caches that value from the assistant
 * message that proposed the call and offers it on the approval decision. The
 * native scheduler appends the durable `tool/call` before the
 * `tools/pre-execute` approval gate, but the decision can reach this adapter
 * before it has mapped that event, and nothing executes before the answer.
 * This module only checks the tagged union the public type declares; it never
 * calls the tool, reads a file, renders a result view or derives a diff from
 * anything but the native view.
 *
 * @module dsh-tui/backend/native-presentation
 */
import type { JsonRecord } from './types.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

const TOOL_CALL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other',
])

function validLocations(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  for (const raw of value) {
    const location = record(raw)
    if (location === undefined || typeof location.path !== 'string') return false
    if (location.line !== undefined && (typeof location.line !== 'number' || !Number.isSafeInteger(location.line))) return false
  }
  return true
}

/**
 * Validate one pure native `ToolCallView`.
 *
 * @param value - the JSON-safe result of a native `presentCall(args)`.
 * @returns the validated call view, or undefined when it is not one.
 */
export function validatedToolCallView(value: unknown): JsonRecord | undefined {
  const view = record(value)
  if (view === undefined || typeof view.title !== 'string') return undefined
  if (view.card === 'generic') {
    if (view.kind !== undefined && (typeof view.kind !== 'string' || !TOOL_CALL_KINDS.has(view.kind))) return undefined
    if (!validLocations(view.locations)) return undefined
    return { ...view }
  }
  if (view.card === 'terminal') {
    if (view.description !== undefined && typeof view.description !== 'string') return undefined
    if (view.cwd !== undefined && typeof view.cwd !== 'string') return undefined
    return { ...view }
  }
  if (view.card === 'diff') {
    if (!Array.isArray(view.diffs)) return undefined
    for (const raw of view.diffs) {
      const diff = record(raw)
      if (diff === undefined || typeof diff.path !== 'string') return undefined
      if (diff.oldText !== null && typeof diff.oldText !== 'string') return undefined
      if (typeof diff.newText !== 'string') return undefined
    }
    if (!validLocations(view.locations)) return undefined
    return { ...view }
  }
  return undefined
}