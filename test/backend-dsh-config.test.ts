/** Parent-owned acceptance: native profiles/defaults/catalog, not importer fixtures. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DshBackend } from '../src/backend/client.ts'
import { resolveDshInstall } from '../src/backend/discover.ts'
import type { DshOptions, JsonRecord } from '../src/backend/types.ts'

let nativePath: string | undefined
try { nativePath = resolveDshInstall().dir } catch { /* native-only acceptance */ }
const profile = 'native-proof'
const keyRef = 'NATIVE_DSH_CONFIG_PROOF_KEY'
const record = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}

function configuredRows(route: string, model: string, extra: JsonRecord[] = []) {
  return [
    ...extra,
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', disabled: false, config: { providers: {
      [route]: {
        displayName: 'Native DSH proof route', api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: keyRef,
        models: [
          { id: model, name: 'Native profile default', contextWindow: 8192, maxTokens: 1024 },
          { id: model + '-other', name: 'Native profile alternative', contextWindow: 16384, maxTokens: 2048 },
        ],
      },
    } } },
    { id: 'agent-default-model', config: { provider: route, model } },
  ]
}

async function fixture(homeOverride = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-config-proof-'))
  const home = join(directory, 'dsh-home'), cwd = join(directory, 'workspace')
  const profileDir = join(home, 'profiles', profile)
  await mkdir(profileDir, { recursive: true }); await mkdir(cwd)
  const manifest = join(profileDir, 'package.json'), patch = join(profileDir, 'cordis.patch.yml')
  await writeFile(manifest, JSON.stringify({ name: 'native-dsh-profile-proof', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2) + '\n')
  await writeFile(join(profileDir, 'origin.mjs'), `import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
export const name = 'native-profile-origin-proof'
export default function apply(ctx) {
  ctx.inject(['commands'], (child) => child.commands.register({
    definitionId: CommandDefinitionId('native-profile-origin-proof'), name: 'profile-origin',
    description: 'Native relative-module origin proof',
    handler: () => ({ kind: 'success', text: 'Loaded the original native profile module.' }),
  }))
}
`)
  await writeFile(patch, JSON.stringify([
    ...configuredRows('native-profile-route', 'profile-model'),
    { insert: [{ id: 'native-profile-origin', name: './origin.mjs' }] },
  ], null, 2) + '\n')
  const homePatch = join(home, 'cordis.patch.yml'), homeOrigin = join(home, 'home-origin.mjs')
  if (homeOverride) {
    await writeFile(homePatch, JSON.stringify(configuredRows('native-home-route', 'home-model', [
      { insert: [{ id: 'home-origin', name: './home-origin.mjs' }] },
    ]), null, 2) + '\n')
    await writeFile(homeOrigin, `export default function apply(ctx) {
  ctx.inject(['commands'], (child) => child.commands.register({
    definitionId: 'home-origin-proof', name: 'home-origin', description: 'Native home patch origin proof',
    handler: () => ({ kind: 'success', text: 'Loaded the original home patch module.' }),
  }))
}
`)
  }
  const originals = new Map<string, string>()
  for (const file of [manifest, patch, join(profileDir, 'origin.mjs'), ...(homeOverride ? [homePatch, homeOrigin] : [])]) originals.set(file, await readFile(file, 'utf8'))
  const env = new Map<string, string | undefined>()
  const setEnv = (name: string, value: string) => { if (!env.has(name)) env.set(name, process.env[name]); process.env[name] = value }
  setEnv(keyRef, 'fake-native-proof-key')
  setEnv('HOME', directory)
  const backends: DshBackend[] = []
  const backend = (extra: Partial<DshOptions> = {}) => {
    const value = new DshBackend({ cwd, home, profile, dshPath: nativePath, ...extra })
    backends.push(value); return value
  }
  return { directory, home, cwd, backend, setEnv, async assertUnmodified() {
    for (const [file, text] of originals) assert.equal(await readFile(file, 'utf8'), text, 'source profile was not rewritten: ' + file)
  }, async close() {
    await Promise.allSettled(backends.map(backend => backend.close()))
    for (const [name, value] of env) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await rm(directory, { recursive: true, force: true })
  } }
}

test('native named profile supplies default model, catalog and relative plugins without rewriting configuration', { skip: !nativePath }, async () => {
  const f = await fixture()
  try {
    const backend = f.backend()
    const info = await backend.connect()
    assert.equal(info.provider, 'native-profile-route')
    assert.equal(info.model, 'profile-model')
    const models = await backend.command('models') as JsonRecord[]
    assert.ok(models.some(model => model.id === 'native-profile-route/profile-model'))
    assert.ok(models.some(model => model.id === 'native-profile-route/profile-model-other'))
    const origin = record(await backend.command('execute', { line: '/profile-origin' }))
    assert.match(String(record(origin.result).text), /original native profile module/)
    assert.equal(record(origin.result).kind, 'success')
    await backend.command('model', { id: 'native-profile-route/profile-model-other' })
    const next = record(await backend.command('new'))
    assert.equal(next.model, 'profile-model', 'new Agent reads the native default, not the TUI\'s last picker choice')
    await backend.close()
    await f.assertUnmodified()
  } finally { await f.close() }
})

test('native home patch keeps DSH precedence over a selected profile, without merging a second provider catalog', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    const backend = f.backend()
    const info = await backend.connect()
    assert.equal(info.provider, 'native-home-route')
    assert.equal(info.model, 'home-model')
    const models = await backend.command('models') as JsonRecord[]
    assert.ok(models.some(model => model.id === 'native-home-route/home-model'))
    assert.ok(!models.some(model => String(model.id).startsWith('native-profile-route/')), 'whole-row native config replacement is not a TUI merge algorithm')
    const origin = record(await backend.command('execute', { line: '/home-origin' }))
    assert.equal(record(origin.result).kind, 'success')
    assert.match(String(record(origin.result).text), /original home patch module/)
    await backend.close()
    await f.assertUnmodified()
  } finally { await f.close() }
})

test('poisoned Pi import pointers cannot affect native startup even when DSH home is selected through the environment', { skip: !nativePath }, async () => {
  const f = await fixture()
  try {
    const poison = join(f.directory, 'pi', 'models.json')
    await mkdir(join(f.directory, 'pi'))
    await writeFile(poison, '{ INVALID PI CONFIG; MUST NOT BE READ')
    await writeFile(join(f.directory, 'pi', 'auth.json'), '{ INVALID PI AUTH; MUST NOT BE READ')
    f.setEnv('DSH_HOME', f.home)
    f.setEnv('DSH_PI_TUI_MODELS_FILE', poison)
    f.setEnv('DSH_PI_TUI_IMPORT_MODELS', '1')
    const backend = f.backend({ home: undefined })
    const info = await backend.connect()
    assert.equal(info.provider, 'native-profile-route')
    assert.equal(info.model, 'profile-model')
    await backend.close()
    await f.assertUnmodified()
  } finally { await f.close() }
})

test('CLI rejects the removed Pi models flag and production has no importer calls', async () => {
  const bin = fileURLToPath(new URL('../bin/dsh-tui.mjs', import.meta.url))
  const removed = spawnSync(process.execPath, [bin, '--models-file', '/does-not-exist/pi/models.json', '--help'], { encoding: 'utf8' })
  assert.equal(removed.status, 2)
  assert.match(removed.stderr, /DSH|profile/i)
  assert.doesNotMatch(removed.stdout, /Explicit read-only migration/)
  const client = await readFile(fileURLToPath(new URL('../src/backend/client.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(client, /from ['"]\.\/external-models|from ['"]\.\/provider-profiles|loadExternalModels\(|buildProviderProfiles\(/)
})
