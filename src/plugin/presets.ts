import type { Context, Plugin } from '@deepseek-ai/cordis'
import { composeEntries, loadOverlayPatches, resolvePluginResource } from '@deepseek-ai/dsh-app-boot'
import type { Config as PresetConfig } from '@deepseek-ai/dsh-agent-preset'
import { pathToFileURL } from 'node:url'

const PRESETS = ['standard', 'ptc', 'minimal', 'cordis'] as const
const WEB_APP = '@deepseek-ai/dsh-web-app'
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Anchor module resolution at the DSH installation that launched this profile.
 *
 * The TUI package is linked or globally installed outside the profile's runtime
 * resolution scope, so resolving DSH's own packages from `import.meta.url`
 * fails: `@deepseek-ai/dsh-web-app` (the packaged preset assets) and
 * `@deepseek-ai/dsh-agent-preset` (the plugin class DSH mounted) belong to the
 * launcher's installation. `profileContext.installAnchor` is the launcher's own
 * package manifest; `pluginPackages.packageOf` is the same public lookup for an
 * embedded host without the profile launcher.
 */
function installationAnchor(ctx: Context): string {
  const profileContext = objectOf(ctx.get('profileContext'))
  const installAnchor = profileContext?.installAnchor
  if (typeof installAnchor === 'string' && installAnchor.length > 0) return pathToFileURL(installAnchor).href
  const packages = objectOf(ctx.get('pluginPackages'))
  const lookup = packages?.packageOf
  if (packages !== undefined && typeof lookup === 'function') {
    const located: unknown = (lookup as (this: unknown, specifier: string, parentURL: string) => unknown).call(packages, WEB_APP, import.meta.url)
    const manifestPath = objectOf(located)?.manifestPath
    if (typeof manifestPath === 'string' && manifestPath.length > 0) return pathToFileURL(manifestPath).href
  }
  throw new Error('The native DSH launcher did not supply profileContext.installAnchor or a pluginPackages lookup, so the packaged DSH presets cannot be resolved')
}

function nativeResource(specifier: string, anchor: string): string {
  try {
    return resolvePluginResource(specifier, anchor)
  } catch (error) {
    throw new Error(`The DSH installation anchored at ${anchor} does not expose ${specifier}; use the native dsh launcher with its packaged ${WEB_APP} and ${PRESET_PLUGIN} dependencies`, { cause: error })
  }
}

/** Mount DSH's own declarations through its own plugin/schema, without copying tool lists or YAML logic. */
export async function mountNativePresets(ctx: Context): Promise<void> {
  const registry: unknown = ctx.get('agentPresets')
  if (registry === null || typeof registry !== 'object' || !('list' in registry) || typeof registry.list !== 'function') {
    throw new Error('The TUI composition must mount the native DSH agent preset registry')
  }
  const listed: unknown = await registry.list()
  if (!Array.isArray(listed)) throw new Error('DSH returned an invalid agent preset roster')
  const existing = new Set(listed.flatMap((row: unknown) => {
    if (row === null || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string') return []
    return [row.id]
  }))
  const missing = PRESETS.filter(id => !existing.has(id))
  if (missing.length === 0) return
  // Loading through the installation's public package exports keeps definitions and !!js semantics DSH-owned.
  const anchor = installationAnchor(ctx)
  const presetModule = objectOf(await import(pathToFileURL(nativeResource(PRESET_PLUGIN, anchor)).href))
  const plugin = presetModule?.default
  if (typeof plugin !== 'function') throw new Error(`${PRESET_PLUGIN} does not export a plugin entrypoint`)
  for (const id of missing) {
    const path = nativeResource(`${WEB_APP}/presets/${id}.patch.yml`, anchor)
    const rows = composeEntries([loadOverlayPatches('dsh-tui', path)])
    for (const row of rows) {
      if (row.name !== PRESET_PLUGIN) throw new Error('Unexpected native DSH preset declaration')
      // Cordis owns these child fibers and their registration disposers.
      await ctx.plugin(plugin as Plugin, row.config as PresetConfig)
    }
  }
}