/**
 * Pure projection of DSH's native LLM registry responses into the TUI's model
 * rows. DSH owns providers, models, reasoning metadata and defaults; this module
 * only renames/normalizes fields for display and selection.
 *
 * The `id` is a UI correlation key. The native `provider`/`model` values are
 * passed through unchanged to the Agent's own model-selection slot.
 *
 * @module dsh-tui/backend/model-view
 */
export interface ModelSelectionLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface ModelReasoningEffortView {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface ModelReasoningView {
  readonly efforts: readonly ModelReasoningEffortView[]
  readonly defaultEffort?: string
}

export interface ModelRow {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly label: string
  readonly description?: string
  readonly reasoning?: ModelReasoningView
  readonly isDefault?: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Normalize native reasoning metadata; absent/invalid fields are omitted. */
export function reasoningView(value: unknown): ModelReasoningView | undefined {
  const reasoning = record(value)
  if (reasoning === undefined) return undefined
  const efforts = (Array.isArray(reasoning.efforts) ? reasoning.efforts : []).flatMap((level) => {
    const item = record(level)
    if (item === undefined || typeof item.id !== 'string') return []
    return [{
      id: item.id,
      name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    }]
  })
  return {
    efforts,
    ...(typeof reasoning.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
  }
}

/**
 * Map one native provider/model pair to the UI row.
 *
 * @param providerId - native provider id.
 * @param value - one entry from `llm.listModels(providerId)`.
 * @param defaultSelection - native default route used only to mark the default.
 * @returns the row, or undefined when the native entry is malformed.
 */
export function modelRow(
  providerId: string,
  value: unknown,
  defaultSelection: ModelSelectionLike | undefined,
): ModelRow | undefined {
  const model = record(value)
  if (model === undefined || typeof model.id !== 'string' || model.id.length === 0) return undefined
  const reasoning = reasoningView(model.reasoning)
  const isDefault = defaultSelection !== undefined &&
    defaultSelection.provider === providerId && defaultSelection.model === model.id
  return {
    id: `${providerId}/${model.id}`,
    provider: providerId,
    model: model.id,
    label: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(isDefault ? { isDefault: true } : {}),
  }
}

/** Resolve one requested route against the already-built native rows. */
export function selectModelRow(rows: readonly ModelRow[], args: Record<string, unknown>): ModelRow | undefined {
  const wanted = typeof args.id === 'string' ? args.id : undefined
  const wantedProvider = typeof args.provider === 'string' ? args.provider : undefined
  const wantedModel = typeof args.model === 'string' ? args.model : undefined
  if (wanted !== undefined) {
    const exact = rows.find(row => row.id === wanted)
    if (exact !== undefined) return exact
    // Accept the same provider/model pair when a caller supplied a
    // non-canonical id; the native fields remain the authority.
    const separator = wanted.indexOf('/')
    if (separator > 0) {
      const provider = wanted.slice(0, separator)
      const model = wanted.slice(separator + 1)
      const byPair = rows.find(row => row.provider === provider && row.model === model)
      if (byPair !== undefined) return byPair
    }
  }
  if (wantedProvider !== undefined && wantedModel !== undefined) {
    return rows.find(row => row.provider === wantedProvider && row.model === wantedModel)
  }
  return undefined
}

/**
 * Keep an explicit reasoning level only when the target native model still
 * advertises it; otherwise the target's own default applies.
 */
export function carriedEffort(
  reasoning: ModelReasoningView | undefined,
  previous: string | undefined,
): string | undefined {
  const efforts = reasoning?.efforts ?? []
  // Only an explicit level the target still advertises survives. Otherwise the
  // route omits effort, so DSH's own adapter default applies; the adapter never
  // promotes a target default into an explicit level.
  return typeof previous === 'string' && efforts.some(level => level.id === previous) ? previous : undefined
}