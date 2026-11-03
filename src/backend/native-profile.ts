/**
 * Native DSH profile planning for one TUI runtime.
 *
 * The TUI never invents a second configuration engine: DSH's installed public
 * profile helpers resolve profile directories, read manifests and parse patch
 * files, and the actual `dsh` launcher composes bundle layers, the profile's
 * own patch, the home-level patch and this application's `--patch` overlay in
 * their native order.
 *
 * A profile is an application surface: its bundle list may mount another
 * frontend (web, headless, ACP, SDK, a third-party TUI). This TUI owns the
 * terminal and the root Agent, so recognized DSH application bundles and the
 * supported legacy TUI are replaced by the TUI composition while the profile's
 * own configuration rows (provider routes, model defaults, credential
 * references, plugin settings) are kept and applied natively. Replacement is
 * reported, never silent, and a configuration layer that would insert a
 * recognized frontend fails with an actionable error instead of starting a
 * second stdio consumer. Utility `bin` entries in ordinary plugins are not
 * treated as applications: that heuristic would drop valid plugin bundles.
 *
 * @module dsh-pi-tui/backend/native-profile
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { backendError } from './errors.ts'
import type { NativeProfileApi } from './native-codec.ts'
import type { JsonRecord } from './types.ts'

/** Profile name used for the application-owned composition (no `--profile`). */
export const APP_PROFILE_NAME = 'dsh-pi-tui'

/** Known legacy TUI application, in addition to DSH's own template surfaces. */
const LEGACY_TUI_BUNDLES = new Set(['@deepseek-harness-tui/dsh-tui'])

export interface ReplacedBundle {
  bundle: string
  reason: string
}

export interface SuppressedRow {
  /** Native patch row id targeted by the scratch overlay. */
  id: string
  /** Recognized frontend package name. */
  name: string
  /** Native patch file that inserted/named the row. */
  source: string
}

export interface ProfilePlan {
  /** Native profile name the launcher boots inside the scratch home. */
  name: string
  /** Real profile directory whose configuration is reused (`undefined` for the app profile). */
  sourceDir?: string
  /** Bundle layers written to the scratch profile manifest. */
  bundles: readonly string[]
  /** Native manifest kept intact except for replacing frontend bundle entries. */
  manifest?: JsonRecord
  /** Application-surface bundles replaced by this TUI. */
  replaced: ReplacedBundle[]
  /** Frontend rows disabled in the scratch overlay (user patch is untouched). */
  suppressedRows?: SuppressedRow[]
  /** User-facing diagnostics (never secrets). */
  warnings: string[]
}

export interface PlanProfileOptions {
  native: NativeProfileApi
  /** Absolute package.json path of the selected dsh installation (bundle resolution anchor). */
  installAnchor: string
  /** Selected durable DSH home. */
  home: string
  /** Explicit `--profile` name; absent selects the application composition. */
  profile?: string
}

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim().length === 0)) return undefined
  return value as string[]
}

interface PatchRow {
  id?: string
  name: string
}

/** Frontend-shaped rows in one native patch list (`insert`, group children and rows). */
function patchRows(patches: readonly JsonRecord[] | undefined): PatchRow[] {
  const rows: PatchRow[] = []
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const item of entries) {
      const entry = record(item)
      if (entry === undefined) continue
      if (typeof entry.name === 'string' && entry.name.trim().length > 0) {
        const name = entry.name.trim()
        if (!name.startsWith('.') && !name.startsWith('/') && !name.startsWith('file:') && !name.includes('\\')) {
          rows.push({ ...(typeof entry.id === 'string' && entry.id.length > 0 ? { id: entry.id } : {}), name })
        }
      }
      visit(entry.insert)
      visit(entry.group)
    }
  }
  visit(patches)
  return rows
}

/**
 * Plan the native profile for one TUI runtime.
 *
 * Without `--profile` the application-owned composition is exactly DSH's own
 * `DEFAULT_PROFILE_BUNDLES` (what `dsh plugin --profile <new>` initializes).
 * With `--profile`, the selected profile's bundle list is reused except for
 * recognized DSH application surfaces and the supported legacy TUI. Other
 * bundles stay in their original order, even if they also ship a utility bin.
 *
 * @throws BackendError `INVALID_OPTIONS` for an unusable name/profile and
 *   `PROFILE_UNSUPPORTED` when the profile cannot host this TUI safely.
 */
export function planProfile(options: PlanProfileOptions): ProfilePlan {
  const { native } = options
  const requested = options.profile?.trim()
  if (requested === undefined || requested.length === 0) {
    return {
      name: APP_PROFILE_NAME,
      bundles: [...native.defaultBundles],
      replaced: [],
      warnings: [],
    }
  }
  let sourceDir: string
  try { sourceDir = native.resolveProfileDir(requested, options.home) }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw backendError('INVALID_OPTIONS', detail.replace(/^dsh: invalid profile name/, 'invalid DSH profile name'))
  }
  if (!existsSync(join(sourceDir, 'package.json'))) {
    throw backendError(
      'INVALID_OPTIONS',
      `DSH profile ${JSON.stringify(requested)} does not exist at ${sourceDir}; ` +
        `create it with 'dsh plugin --profile ${requested} add <package>' or select an existing profile`,
    )
  }
  const manifest = native.readManifest(sourceDir)
  const profileManifest = record(record(manifest.dsh)?.profile)
  const declared = stringList(profileManifest?.bundles)
  if (declared === undefined || declared.length === 0) {
    throw backendError(
      'PROFILE_UNSUPPORTED',
      `DSH profile ${JSON.stringify(requested)} declares no dsh.profile.bundles list at ${sourceDir}; ` +
        'DSH TUI can only reuse an initialized DSH profile',
    )
  }
  const core = native.defaultBundles
  const missingCore = core.filter(bundle => !declared.includes(bundle))
  if (missingCore.length > 0) {
    throw backendError(
      'PROFILE_UNSUPPORTED',
      `DSH profile ${JSON.stringify(requested)} does not mount the shared core bundle (${missingCore.join(', ')}); ` +
        'DSH TUI needs that composition and does not synthesize it',
    )
  }

  const surfaces = new Set([...native.shippedSurfaceBundles, ...LEGACY_TUI_BUNDLES])
  const kept: string[] = []
  const replaced: ReplacedBundle[] = []
  for (const bundle of declared) {
    if (surfaces.has(bundle)) {
      replaced.push({ bundle, reason: native.shippedSurfaceBundles.includes(bundle) ? 'DSH shipped application surface' : 'recognized legacy DSH TUI' })
    } else kept.push(bundle)
  }

  // A configuration layer may insert the old TUI (the real dsh-tui profile
  // does). It must not start a second terminal, so target that exact row in the
  // highest-priority scratch overlay. The user's patch file stays untouched.
  const suppressedRows: SuppressedRow[] = []
  const patchFiles = [
    join(sourceDir, 'cordis.patch.yml'),
    join(options.home, 'cordis.patch.yml'),
  ]
  const seen = new Set<string>()
  for (const file of patchFiles) {
    for (const row of patchRows(native.loadPatches(file))) {
      if (!surfaces.has(row.name)) continue
      if (row.id === undefined) {
        throw backendError(
          'PROFILE_UNSUPPORTED',
          `the DSH configuration layer ${file} inserts the recognized application frontend ${JSON.stringify(row.name)} without a stable row id. ` +
            'DSH TUI owns the terminal and the root Agent and cannot safely start a second frontend or stdio consumer. ' +
            'Give that row an id, or configure the model routes in a profile that does not insert an application frontend.',
        )
      }
      const key = row.id + '\u0000' + row.name
      if (seen.has(key)) continue
      seen.add(key)
      suppressedRows.push({ id: row.id, name: row.name, source: file })
    }
  }

  const warnings = [
    ...replaced.map(({ bundle, reason }) =>
      `DSH profile ${JSON.stringify(requested)} selects application bundle ${JSON.stringify(bundle)} (${reason}); ` +
      'DSH TUI replaces that frontend with its own terminal, keeps the profile configuration layers, and does not start it.',
    ),
    ...suppressedRows.map(row =>
      `DSH profile ${JSON.stringify(requested)} patch ${row.source} inserts ${JSON.stringify(row.name)} as ${JSON.stringify(row.id)}; ` +
      'DSH TUI disables that row in its private overlay so no second terminal starts. The profile patch is not modified.',
    ),
  ]
  return {
    name: requested,
    sourceDir,
    bundles: kept,
    manifest,
    replaced,
    ...(suppressedRows.length === 0 ? {} : { suppressedRows }),
    warnings,
  }
}