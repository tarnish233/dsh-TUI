import type { SkillCatalogEntry, SkillCatalogSnapshot } from './backend/types.ts'

/** The native DSH /name gesture grammar; this identifies input, not skill existence or policy. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LEADING_SKILL_GESTURE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

/** A literal first-token skill gesture. Bodies and invocation validation remain DSH-owned. */
export function leadingSkillGestureName(text: string): string | undefined {
  return LEADING_SKILL_GESTURE.exec(text)?.[1]
}

/** Strictly read the neutral metadata envelope without retaining any native object or skill body. */
export function readSkillCatalog(value: unknown): SkillCatalogSnapshot | undefined {
  const snapshot = object(value)
  if (snapshot === undefined || typeof snapshot.available !== 'boolean' ||
    typeof snapshot.complete !== 'boolean' || !Array.isArray(snapshot.entries)) return undefined
  if (!snapshot.available) return { entries: [], available: false, complete: false }
  const entries: SkillCatalogEntry[] = []
  let complete = snapshot.complete
  for (const value of snapshot.entries) {
    const entry = object(value)
    if (typeof entry?.name !== 'string' || !SKILL_NAME.test(entry.name) ||
      typeof entry.description !== 'string' || typeof entry.modelInvocable !== 'boolean' ||
      (entry.whenToUse !== undefined && typeof entry.whenToUse !== 'string')) {
      complete = false
      continue
    }
    entries.push({
      name: entry.name,
      description: entry.description,
      modelInvocable: entry.modelInvocable,
      ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
    })
  }
  return { entries, available: true, complete }
}
