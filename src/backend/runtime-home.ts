/**
 * Private runtime workspace for one backend instance.
 *
 * The real `dsh` launcher boots a native profile, so no global profile is
 * created or edited. Two layers:
 *
 * - Home isolation: a throwaway home directory whose durable data and auth
 *   entries (credentials, sessions, storages, attachments, skills, cache,
 *   legacy settings, home patch) are symlinks into the selected real DSH home.
 *   The runtime therefore uses the user's own auth/routing/sessions while the
 *   launcher's unavoidable profile-root write stays in scratch.
 * - Profile reuse: when the caller selected `--profile`, the selected profile's
 *   directory entries are mirrored into a scratch profile directory. The
 *   profile patch is copied (and patch-relative assets materialized) so Node
 *   resolves modules inside the scratch profiles tree; other entries such as
 *   `node_modules` and `compatibility.json` are linked. Only `package.json`
 *   and the launcher-written `cordis.yml` are regenerated, so the profile's
 *   own native layers are read without any write to the user's profile.
 *   Without a selection, DSH's own `DEFAULT_PROFILE_BUNDLES` initialize the
 *   application profile in scratch.
 *
 * The applied stack is exactly native: bundle layers, the profile patch, the
 * home patch, then this application's `--patch` overlay (which mounts the
 * bridge/agent-preset roster and disables host rows that would conflict with
 * the terminal or a per-Agent preset). No YAML merge, provider, catalog or
 * credential algorithm is duplicated here.
 *
 * DSH 0.2.1-rc.5 resolves exactly one `DSH_HOME` for the whole process and has
 * no "overlay home" seam, so this minimal link-based isolation glue is retained
 * and documented instead of being replaced by an API that does not exist. All
 * writes stay in the scratch home; existing user profiles, patches and
 * credentials are only read.
 *
 * @module dsh-pi-tui/backend/runtime-home
 */
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { NativeProfileApi } from './native-codec.ts'
import type { ProfilePlan } from './native-profile.ts'
import type { JsonRecord } from './types.ts'

/**
 * DSH-home directories the runtime writes. They are created in the selected
 * home when absent and linked into the private home so sessions, storages,
 * attachments, caches, skills and DeepSeek route state stay durable.
 */
const DURABLE_DIRECTORIES = ['sessions', 'storages', 'attachments', 'cache', 'skills', 'llm-deepseek'] as const

/**
 * DSH-home documents inherited in place when the selected home has them:
 * managed credentials, the home `.env`, the anonymous user id, and the legacy
 * `settings.yaml` document (copied, never linked, because the settings service
 * archives it on import). The home patch is copied separately so its relative
 * module anchors stay in the scratch home.
 *
 * `dsh-runtimes` and `.agent-presets` are deliberately gone: the tested
 * 0.2.1-rc.5 composition never reads them.
 */
const INHERITED_ENTRIES = [
  '.credentials.yaml',
  '.env',
  '.anonymous-user-id',
] as const

/** Legacy settings document imported once by the native settings service. */
const LEGACY_SETTINGS = 'settings.yaml'

/** Highest-precedence overlay applied after the profile and home patch layers. */
const BRIDGE_OVERLAY = 'dsh-pi-tui.patch.yml'

/**
 * `dsh-base` host-plane rows whose model-facing tools now belong to an Agent
 * preset. Disabling them here mirrors the official web composition, so a
 * `minimal` Agent cannot inherit Standard's tools from the host layer.
 */
const PRESET_OWNED_HOST_ROWS = [
  'tool-plugin-manager',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'tool-fs',
  'tool-fs-search',
  'skill-filesystem',
  'tool-skill',
  'command-goal',
  'tool-goal',
  'plan-mode',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'workflow-ptc',
  'tool-workflow',
  'agent-instructions',
  'tool-todo',
  'tool-web',
] as const

/** Host services the shipped preset declarations read but `dsh-base` omits. */
const PRESET_HOST_SERVICES = [
  {
    id: 'dsh-pi-tui-agent-preset-registry',
    name: '@deepseek-ai/dsh-agent-preset-registry',
    config: { default: 'standard' },
  },
  {
    id: 'dsh-pi-tui-subagent-model-selection-settings',
    name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings',
  },
  {
    id: 'dsh-pi-tui-cordis-host-runner',
    name: '@deepseek-ai/dsh-cordis-host-runner',
  },
  {
    id: 'dsh-pi-tui-cordis-inspect-providers',
    name: '@deepseek-ai/dsh-tool-cordis/host',
  },
] as const

export interface RuntimeWorkspace {
  /** DSH_HOME handed to the launcher. */
  homeDir: string
  /** Native DSH profile name booted by the launcher. */
  profileName: string
  /** Private profile directory booted by the launcher. */
  profileDir: string
  /** Whether this workspace was created here and must be removed on close. */
  owned: boolean
  /** `--patch` overlay that inserts the bridge (highest native layer). */
  patchPath: string
  /** Selected durable DSH home (never written through by this module). */
  dataHome: string
  /** Remove an owned workspace (no-op for caller-owned homes). */
  cleanup(): void
}

/**
 * Fixture/no-helper fallback for the selected durable home: `$DSH_HOME` when
 * set, then `~/.dsh` — the precedence `@deepseek-ai/dsh-home-paths` documents.
 *
 * The production client always passes the native resolver (loaded through the
 * caller's async public-export loader), so this path only serves tests and
 * fixtures that build a workspace directly. It is never a silent fallback for
 * a failing native resolver: a supplied {@link PrepareWorkspaceOptions.resolveHome}
 * that throws is propagated instead of guessed around.
 */
export function defaultDshHome(environment: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = environment.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** Normalize a resolver result, rejecting anything that is not an absolute path. */
function resolvedHome(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} returned no DeepSeek Harness home`)
  }
  return resolve(value.trim())
}

/**
 * Resolve the selected durable home. Caller-supplied native resolution wins;
 * without one, the documented fixture precedence applies.
 */
export function resolveRuntimeHome(
  options: Pick<PrepareWorkspaceOptions, 'home' | 'resolveHome'> = {},
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = typeof options.home === 'string' && options.home.trim().length > 0 ? resolve(options.home.trim()) : undefined
  if (explicit !== undefined) return explicit
  if (options.resolveHome !== undefined) {
    // Native resolution is authoritative: a failure or an empty answer is
    // reported, never replaced by a locally guessed home.
    return resolvedHome(options.resolveHome(undefined), 'native DSH home resolution')
  }
  return defaultDshHome(environment)
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function linkEntry(target: string, link: string): void {
  if (existsSync(link)) return
  try {
    const stat = lstatSync(target)
    symlinkSync(target, link, stat.isDirectory() ? 'dir' : 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function mirrorProfile(native: Pick<NativeProfileApi, 'writeManifest' | 'loadPatches'>, plan: ProfilePlan, profileDir: string): void {
  const source = plan.sourceDir
  if (source === undefined) throw new Error('a mirrored profile needs a source directory')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  // The patch and every top-level root it references with a relative './'
  // path must be real files under the scratch profile. Node resolves symlinks
  // to their real path, so linking them would anchor module resolution back in
  // the user's home, outside the scratch profiles tree and its DSH resolution.
  const copiedRoots = relativePatchRoots(native, source, join(source, 'cordis.patch.yml'))
  for (const root of copiedRoots) {
    if (!existsSync(join(source, root))) throw new Error(`profile patch references a missing relative asset: ${root}`)
  }
  for (const entry of readdirSync(source)) {
    if (entry === 'package.json' || entry === 'cordis.yml') continue
    if (entry === 'cordis.patch.yml' || copiedRoots.has(entry)) {
      // A root that was previously a read-only link becomes a real copy when
      // the patch starts referencing it. Remove the link/file first: cpSync
      // refuses to copy a source onto a symlink that resolves to itself.
      const target = join(profileDir, entry)
      rmSync(target, { recursive: true, force: true })
      cpSync(join(source, entry), target, { recursive: true, dereference: true })
    } else linkEntry(join(source, entry), join(profileDir, entry))
  }
  const original = plan.manifest ?? { name: `dsh-profile-${plan.name}`, private: true }
  const dsh = record(original.dsh) ?? {}
  const profile = record(dsh.profile) ?? {}
  const manifest: JsonRecord = {
    ...original,
    dsh: { ...dsh, profile: { ...profile, bundles: [...plan.bundles] } },
  }
  native.writeManifest(profileDir, manifest)
}

/** Top-level roots referenced by patch-relative './' entries. */
function relativePatchRoots(native: Pick<NativeProfileApi, 'loadPatches'>, sourceDir: string, patchFile: string): Set<string> {
  const roots = new Set<string>()
  const base = resolve(sourceDir)
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const item of entries) {
      const entry = record(item)
      if (entry === undefined) continue
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (name.startsWith('./') || name.startsWith('../') || name.startsWith('file:')) {
        let target: string
        try { target = name.startsWith('file:') ? fileURLToPath(name) : resolve(base, name) }
        catch { continue }
        if (target.startsWith(base + '/')) {
          const root = target.slice(base.length + 1).split('/')[0]
          if (root !== undefined && root !== '') roots.add(root)
        }
      }
      visit(entry.insert); visit(entry.group)
    }
  }
  visit(native.loadPatches(patchFile))
  return roots
}

/** Copy one home patch and materialize its patch-relative roots in scratch. */
function materializeHomePatch(native: Pick<NativeProfileApi, 'loadPatches'>, sourceHome: string, scratchHome: string): void {
  const source = join(sourceHome, 'cordis.patch.yml')
  if (!existsSync(source)) return
  // Parse/validate before replacing the scratch copy: an invalid edit must not
  // poison the live runtime's watched patch.
  const roots = relativePatchRoots(native, sourceHome, source)
  for (const root of roots) {
    if (!existsSync(join(sourceHome, root))) throw new Error(`home patch references a missing relative asset: ${root}`)
  }
  copyFileSync(source, join(scratchHome, 'cordis.patch.yml'))
  for (const root of roots) {
    const target = join(scratchHome, root)
    // Preserve the durable-home links (sessions, skills, …); a relative root
    // that is already a link is live. A real scratch copy must be refreshed so
    // a home plugin edit does not keep running launch-time bytes.
    try {
      if (lstatSync(target).isSymbolicLink()) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    rmSync(target, { recursive: true, force: true })
    cpSync(join(sourceHome, root), target, { recursive: true, dereference: true })
  }
}

/** YAML flow rendering for one JSON-safe row (readable and still JSON-shaped). */
function yamlFlow(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(yamlFlow).join(', ') + ']'
  if (value !== null && typeof value === 'object') {
    return '{ ' + Object.entries(value as JsonRecord)
      .map(([key, item]) => JSON.stringify(key) + ': ' + yamlFlow(item))
      .join(', ') + ' }'
  }
  return JSON.stringify(value)
}

/**
 * A row that yields to the same native service when the selected profile
 * already mounts one. The expression is evaluated by the loader, not here.
 */
function nativeServiceRow(row: (typeof PRESET_HOST_SERVICES)[number]): string[] {
  const condition = `[...ctx.loader.entries()].some(entry => entry.options.name === ${JSON.stringify(row.name)} && entry.options.id !== ${JSON.stringify(row.id)} && !entry.disabled)`
  return [
    `    - id: ${row.id}`,
    `      name: ${JSON.stringify(row.name)}`,
    ...('config' in row ? [`      config: ${yamlFlow(row.config)}`] : []),
    `      disabled: !!js ${JSON.stringify(condition)}`,
  ]
}

/** The one overlay this application owns: bridge row plus terminal-safe defaults. */
function writeBridgeOverlay(path: string, bridgePath: string, plan: ProfilePlan): void {
  const rows: string[] = []
  const push = (value: JsonRecord): void => { rows.push('- ' + yamlFlow(value)) }
  // Disable only the exact frontend rows recognized in the user's native
  // configuration; the source profile patch itself is never edited.
  for (const row of plan.suppressedRows ?? []) push({ id: row.id, disabled: true })
  // Model-facing rows now come from the selected Agent preset. Base services
  // (jobs/goal/subagent registries, token meter, shell env) stay mounted.
  for (const id of PRESET_OWNED_HOST_ROWS) push({ id, disabled: true })
  // Insert the preset roster/services and this bridge. These are new rows, so
  // they must be inside an `insert` block rather than id-targeted overrides.
  rows.push('- insert:')
  for (const row of PRESET_HOST_SERVICES) rows.push(...nativeServiceRow(row))
  rows.push(
    '    - id: dsh-pi-tui-bridge',
    '      name: ' + JSON.stringify(pathToFileURL(bridgePath).href),
  )
  // Native profile/HMR watches stay on the scratch copies; the backend syncs
  // real profile/home edits into them before asking HMR to reconcile. Source
  // watching stays opt-in through the profile's own hmr config.
  push({ id: 'hmr', disabled: false })
  // No model-backed titling hidden in the TUI (the deterministic native title
  // service stays available).
  push({ id: 'session-title-llm', disabled: true })
  // JSON flow rows plus the two loader expressions; no credentials.
  writeFileSync(path, rows.join('\n') + '\n', { mode: 0o600 })
}


export interface SyncWorkspaceOptions {
  /** Existing private workspace to update in place. */
  workspace: RuntimeWorkspace
  /** Freshly planned native profile (bundles already filtered). */
  plan: ProfilePlan
  /** Installed public profile helpers used for manifest/patch parsing. */
  native: Pick<NativeProfileApi, 'writeManifest' | 'loadPatches'>
}

/**
 * Refresh the scratch profile/home configuration from the selected real
 * sources. Used by `/reload`; native HMR then recomposes its own tree. The
 * caller has already re-run `planProfile`, so an invalid profile fails before
 * any scratch file is touched.
 */
export function syncWorkspace(options: SyncWorkspaceOptions): void {
  const { workspace, plan, native } = options
  if (plan.sourceDir !== undefined) {
    mirrorProfile(native, plan, workspace.profileDir)
    if (!existsSync(join(plan.sourceDir, 'cordis.patch.yml'))) {
      rmSync(join(workspace.profileDir, 'cordis.patch.yml'), { force: true })
    }
  }
  const sourceHomePatch = join(workspace.dataHome, 'cordis.patch.yml')
  const scratchHomePatch = join(workspace.homeDir, 'cordis.patch.yml')
  if (!existsSync(sourceHomePatch)) {
    rmSync(scratchHomePatch, { force: true })
  } else {
    materializeHomePatch(native, workspace.dataHome, workspace.homeDir)
  }
}

export interface PrepareWorkspaceOptions {
  /** Absolute path of the runtime bridge plugin. */
  bridgePath: string
  /** Already resolved native profile plan. */
  plan: ProfilePlan
  /** Installed public profile helpers bound by the caller's async loader. */
  native: Pick<NativeProfileApi, 'initProfile' | 'writeManifest' | 'loadPatches'>
  /** Already resolved durable data/auth home to inherit. */
  home?: string
  /**
   * Native home resolver supplied by the caller's async loader, e.g.
   * `home => resolveDshHome(home)`. Omitted only by tests/fixtures: production
   * always passes the installed public helper, and its failure is reported
   * instead of being replaced by a guessed home.
   */
  resolveHome?: (home?: string) => string
  /**
   * Installed `@deepseek-ai/dsh` manifest, recorded as internal install
   * metadata. Home resolution happens in the caller's loader, not here.
   */
  dshPackageJsonPath?: string
}

/** Build (or reuse) the private runtime workspace for one backend. */
export function prepareWorkspace(options: PrepareWorkspaceOptions): RuntimeWorkspace {
  if (!existsSync(options.bridgePath)) {
    throw new Error(`runtime bridge is missing at ${options.bridgePath}`)
  }
  const plan = options.plan
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runtime-'))
  const realHome = resolveRuntimeHome({ home: options.home, ...(options.resolveHome === undefined ? {} : { resolveHome: options.resolveHome }) })
  const profilesDir = join(homeDir, 'profiles')
  const profileDir = join(profilesDir, plan.name)
  const patchPath = join(homeDir, BRIDGE_OVERLAY)
  try {
    mkdirSync(profilesDir, { recursive: true, mode: 0o700 })
    // Data is durable in the selected home; only the generated profile is private.
    // This also makes a new/explicit data home useful after the runtime closes.
    mkdirSync(realHome, { recursive: true, mode: 0o700 })
    for (const entry of DURABLE_DIRECTORIES) {
      const target = join(realHome, entry)
      mkdirSync(target, { recursive: true, mode: 0o700 })
      linkEntry(target, join(homeDir, entry))
    }
    for (const entry of INHERITED_ENTRIES) {
      linkEntry(join(realHome, entry), join(homeDir, entry))
    }
    // The home patch is a real scratch file for the same patch-relative anchor
    // reason as a mirrored profile; its relative assets are linked explicitly.
    materializeHomePatch(options.native, realHome, homeDir)
    const legacySettings = join(realHome, LEGACY_SETTINGS)
    if (existsSync(legacySettings)) copyFileSync(legacySettings, join(homeDir, LEGACY_SETTINGS))
    // Shared profile packages resolve through the same layer the real home uses.
    linkEntry(join(realHome, 'profiles', 'node_modules'), join(profilesDir, 'node_modules'))
    if (plan.sourceDir === undefined) {
      // Native initialization: manifest, empty user patch layer and pnpm settings.
      options.native.initProfile(profileDir, plan.bundles)
    } else {
      mirrorProfile(options.native, plan, profileDir)
    }
    writeBridgeOverlay(patchPath, options.bridgePath, plan)
  } catch (error) {
    rmSync(homeDir, { recursive: true, force: true })
    throw error
  }
  return {
    homeDir,
    profileName: plan.name,
    profileDir,
    owned: true,
    patchPath,
    dataHome: realHome,
    cleanup: () => {
      try {
        // Only the private skeleton is removed; the selected home and every
        // target behind these links belong to the user.
        rmSync(homeDir, { recursive: true, force: true })
      } catch {
        // Scratch cleanup failure must not mask the shutdown result.
      }
    },
  }
}