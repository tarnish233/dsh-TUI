/** Native package resolution belongs to the installation that supplied this Context. */
import { resolvePluginResource } from '@deepseek-ai/dsh-app-boot'
import { pathToFileURL } from 'node:url'

interface ResourceHost { get(name: string): unknown }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Read public launcher/package metadata only, never profile or credential contents. */
export function nativeInstallationAnchor(host: ResourceHost): string | undefined {
  try {
    const anchor = object(host.get('profileContext'))?.installAnchor
    if (typeof anchor === 'string' && anchor.length > 0) return pathToFileURL(anchor).href
    const packages = object(host.get('pluginPackages'))
    const lookup = packages?.packageOf
    if (packages !== undefined && typeof lookup === 'function') {
      const located: unknown = lookup.call(packages, '@deepseek-ai/dsh-web-app', import.meta.url)
      const manifestPath = object(located)?.manifestPath
      if (typeof manifestPath === 'string' && manifestPath.length > 0) return pathToFileURL(manifestPath).href
    }
  } catch { /* An embedded/minimal host may not have launcher metadata. */ }
  return undefined
}

export function nativeResourceURL(specifier: string, anchor: string): string {
  return pathToFileURL(resolvePluginResource(specifier, anchor)).href
}
