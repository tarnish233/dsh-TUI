/**
 * Regression for the native startup preset mount: the packaged DSH preset
 * assets and the `@deepseek-ai/dsh-agent-preset` plugin class must resolve from
 * the host installation anchor (`profileContext.installAnchor` /
 * `pluginPackages`), never from an accidental peer/root resolution from this
 * package. The fixture is a temporary local package tree; no profile,
 * credential, model or network resource is touched.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { mountNativePresets } from '../src/plugin/presets.ts'

const PRESETS = ['standard', 'ptc', 'minimal', 'cordis'] as const
const WEB_APP = '@deepseek-ai/dsh-web-app'
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

class FakePresetHost {
  readonly services = new Map<string, unknown>()
  readonly mounted: Array<{ plugin: unknown; config: unknown }> = []
  get(name: string): unknown {
    return this.services.get(name)
  }
  use(name: string, service: unknown): this {
    this.services.set(name, service)
    return this
  }
  async plugin(plugin: unknown, config?: unknown): Promise<void> {
    this.mounted.push({ plugin, config })
  }
}

interface PresetFixture {
  readonly directory: string
  readonly install: string
  readonly webAppDir: string
  readonly anchor: string
  readonly presetModulePath: string
  cleanup(): Promise<void>
}

/** A local installation carrying exported preset assets and one fake native plugin class. */
async function presetFixture(): Promise<PresetFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))
  const install = join(directory, 'install')
  const webAppDir = join(install, 'node_modules', WEB_APP)
  const presetModuleDir = join(install, 'node_modules', PRESET_PLUGIN)
  await mkdir(join(webAppDir, 'presets'), { recursive: true })
  await mkdir(presetModuleDir, { recursive: true })
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-fixture-install', version: '0.0.0' }))
  await writeFile(join(webAppDir, 'package.json'), JSON.stringify({
    name: WEB_APP,
    version: '0.0.0',
    type: 'module',
    exports: { './presets/*.patch.yml': './presets/*.patch.yml', './package.json': './package.json' },
  }))
  await writeFile(join(presetModuleDir, 'package.json'), JSON.stringify({
    name: PRESET_PLUGIN,
    version: '0.0.0',
    type: 'module',
    exports: { '.': './index.js', './package.json': './package.json' },
  }))
  const presetModulePath = join(presetModuleDir, 'index.js')
  await writeFile(presetModulePath, 'export default class FixtureAgentPreset {}\n')
  for (const [index, id] of PRESETS.entries()) {
    await writeFile(join(webAppDir, 'presets', `${id}.patch.yml`), [
      '- insert:',
      `    - id: preset-${id}`,
      `      name: ${JSON.stringify(PRESET_PLUGIN)}`,
      '      config:',
      `        id: ${id}`,
      `        order: ${index + 1}`,
      '        plugins: []',
      '',
    ].join('\n'))
  }
  return {
    directory, install, webAppDir, anchor: join(install, 'package.json'), presetModulePath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

function mountedIds(host: FakePresetHost): string[] {
  return host.mounted.map(row => {
    assert.notEqual(row.config, null)
    assert.equal(typeof row.config, 'object')
    const config = row.config as { id?: unknown }
    const id = config.id
    assert.equal(typeof id, 'string')
    return id as string
  })
}

test('native presets resolve from profileContext.installAnchor, not this package', async () => {
  const fixture = await presetFixture()
  try {
    const host = new FakePresetHost()
    host.use('agentPresets', { list: async () => [{ id: 'custom' }] })
    host.use('profileContext', { installAnchor: fixture.anchor })
    await mountNativePresets(host as unknown as Context)
    assert.deepEqual(mountedIds(host), [...PRESETS])
    const anchored = await import(pathToFileURL(fixture.presetModulePath).href) as { default: unknown }
    for (const row of host.mounted) {
      assert.equal(row.plugin, anchored.default, 'the installation plugin class is mounted, not a second peer copy')
    }
  } finally {
    await fixture.cleanup()
  }
})

test('native presets fall back to the public pluginPackages lookup without a profile launcher', async () => {
  const fixture = await presetFixture()
  try {
    const host = new FakePresetHost()
    const lookups: Array<{ specifier: string; parentURL: string }> = []
    host.use('agentPresets', { list: async () => [] })
    host.use('pluginPackages', {
      packageOf: (specifier: string, parentURL: string) => {
        lookups.push({ specifier, parentURL })
        return { name: WEB_APP, version: '0.0.0', dir: fixture.webAppDir, manifestPath: join(fixture.webAppDir, 'package.json'), manifest: {} }
      },
    })
    await mountNativePresets(host as unknown as Context)
    assert.deepEqual(mountedIds(host), [...PRESETS])
    assert.equal(lookups.length, 1)
    assert.equal(lookups[0]?.specifier, WEB_APP)
  } finally {
    await fixture.cleanup()
  }
})

test('already registered native presets need no installation anchor', async () => {
  const host = new FakePresetHost()
  host.use('agentPresets', { list: async () => PRESETS.map(id => ({ id })) })
  await mountNativePresets(host as unknown as Context)
  assert.equal(host.mounted.length, 0)
})

test('a missing host anchor fails loudly instead of a peer/root preset fallback', async () => {
  const host = new FakePresetHost()
  host.use('agentPresets', { list: async () => [] })
  await assert.rejects(mountNativePresets(host as unknown as Context), /profileContext\.installAnchor|pluginPackages/)
  assert.equal(host.mounted.length, 0)
})