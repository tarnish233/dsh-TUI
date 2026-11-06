import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureNativeAttachment, type AttachmentOptions, type AttachmentRunResult, type NativeAttachmentApi } from '../src/plugin/attachment.ts'

const APP = 'dsh-tui'
const OLD_APP = ['dsh', 'pi', 'tui'].join('-')
interface Document {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[]; unrelated: string } }
  unrelated: { preserved: boolean }
}

async function fixture(present = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-attachment-'))
  const home = join(directory, 'home')
  const profileDirectory = join(home, 'profiles/dsh-tui')
  const packageDirectory = join(directory, 'local-application')
  const copyDirectory = join(directory, 'old-copy')
  await mkdir(packageDirectory, { recursive: true })
  await mkdir(copyDirectory, { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: APP }))
  let state: Document = {
    dependencies: { unrelated: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], unrelated: 'retained' } },
    unrelated: { preserved: true },
  }
  if (present) {
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify(state))
  }
  let resolvedDirectory = packageDirectory
  const calls: Array<{ args: string[]; options: AttachmentOptions }> = []
  const reports: string[] = []
  const locations: Array<{ profile: string; home?: string }> = []
  let hook: ((args: readonly string[], options: AttachmentOptions) => Promise<AttachmentRunResult>) | undefined
  const apply = async (args: readonly string[]) => {
    if (args[0] === 'add') {
      state.dependencies[APP] = `link:${packageDirectory}`
      if (!state.dsh.profile.bundles.includes(APP)) state.dsh.profile.bundles.push(APP)
      resolvedDirectory = packageDirectory
    } else if (args[0] === 'remove') {
      for (const name of args.slice(args.indexOf('--') + 1)) {
        delete state.dependencies[name]
        state.dsh.profile.bundles = state.dsh.profile.bundles.filter(bundle => bundle !== name)
      }
    }
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(join(profileDirectory, 'package.json'), JSON.stringify(state))
  }
  const api: NativeAttachmentApi = {
    profileDirectory(profile, configuredHome) {
      locations.push({ profile, home: configuredHome })
      return profileDirectory
    },
    manifest: () => structuredClone(state),
    bundleDirectory(name) {
      if (!(name in state.dependencies)) throw new Error('package absent')
      return resolvedDirectory
    },
    async run(profile, destination, args, options) {
      assert.equal(profile, options.profile)
      assert.equal(destination, profileDirectory)
      calls.push({ args: [...args], options })
      if (hook) return await hook(args, options)
      await apply(args)
      return { exitCode: 0 }
    },
  }
  const options: AttachmentOptions = {
    executable: 'not-executed-with-an-injected-api', profile: APP, cwd: directory,
    env: { HOME: home, DSH_HOME: home }, packageDirectory,
    report: message => reports.push(message),
  }
  return {
    directory, home, profileDirectory, packageDirectory, copyDirectory, api, options, calls, reports, locations, apply,
    get state() { return state },
    set state(value: Document) { state = value },
    set resolvedDirectory(value: string) { resolvedDirectory = value },
    set hook(value: typeof hook) { hook = value },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>, present = true) {
  const value = await fixture(present)
  try { await run(value) } finally { await value.cleanup() }
}

function mounted(value: Awaited<ReturnType<typeof fixture>>) {
  value.state.dependencies[APP] = `link:${value.packageDirectory}`
  value.state.dsh.profile.bundles.push(APP)
}

function previousApplication(value: Awaited<ReturnType<typeof fixture>>) {
  value.state.dependencies[OLD_APP] = `file:${value.packageDirectory}`
  value.state.dsh.profile.bundles.push(OLD_APP)
}

test('first alias launch attaches through native package operations and preserves unrelated fields', async () => {
  await withFixture(async value => {
    await ensureNativeAttachment(value.options, value.api)
    assert.deepEqual(value.calls.map(call => call.args), [['add', '--ignore-scripts', `link:${value.packageDirectory}`]])
    assert.deepEqual(value.state.dsh.profile.bundles, ['@deepseek-ai/dsh-base', APP])
    assert.equal(value.state.dependencies.unrelated, '1.0.0')
    assert.equal(value.state.dsh.profile.unrelated, 'retained')
    assert.deepEqual(value.state.unrelated, { preserved: true })
    assert.equal(value.reports.length, 1)
    assert.equal(value.calls[0]?.options.signal instanceof AbortSignal, true)
  })
})

test('a missing profile is initialized only by the native package operation', async () => {
  await withFixture(async value => {
    await ensureNativeAttachment(value.options, value.api)
    assert.equal(value.calls.length, 1)
    assert.ok(value.state.dsh.profile.bundles.includes(APP))
  }, false)
})

test('an already mounted local application performs no package write or progress output', async () => {
  await withFixture(async value => {
    mounted(value)
    const before = structuredClone(value.state)
    await ensureNativeAttachment(value.options, value.api)
    assert.deepEqual(value.state, before)
    assert.equal(value.calls.length, 0)
    assert.equal(value.reports.length, 0)
  })
})

test('a selected but absent application bundle is repaired instead of launching headless', async () => {
  await withFixture(async value => {
    value.state.dsh.profile.bundles.push(APP)
    await ensureNativeAttachment(value.options, value.api)
    assert.equal(value.calls.length, 1)
    assert.equal(value.state.dsh.profile.bundles.filter(name => name === APP).length, 1)
  })
})

test('renaming the same local application installs its new identity before removing the old alias', async () => {
  await withFixture(async value => {
    previousApplication(value)
    await ensureNativeAttachment(value.options, value.api)
    assert.deepEqual(value.calls.map(call => call.args), [
      ['add', '--ignore-scripts', `link:${value.packageDirectory}`],
      ['remove', '--ignore-scripts', '--', OLD_APP],
    ])
    assert.equal(value.state.dependencies[OLD_APP], undefined)
    assert.equal(value.state.dsh.profile.bundles.includes(OLD_APP), false)
    assert.equal(value.state.dependencies[APP], `link:${value.packageDirectory}`)
  })
})

test('a failed installation never removes the previous local application', async () => {
  await withFixture(async value => {
    previousApplication(value)
    const before = structuredClone(value.state)
    value.hook = async () => ({ exitCode: 1 })
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /exited 1/)
    assert.deepEqual(value.state, before)
    assert.equal(value.calls.length, 1)
    assert.equal(value.calls[0]?.args[0], 'add')
  })
})

test('failed old-alias cleanup is visible and the next launch retries cleanup without reinstalling', async () => {
  await withFixture(async value => {
    previousApplication(value)
    value.hook = async args => {
      if (args[0] === 'remove') return { exitCode: 1 }
      await value.apply(args)
      return { exitCode: 0 }
    }
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /exited 1/)
    assert.ok(value.state.dependencies[APP])
    assert.ok(value.state.dependencies[OLD_APP])
    value.hook = undefined
    value.calls.length = 0
    await ensureNativeAttachment(value.options, value.api)
    assert.deepEqual(value.calls.map(call => call.args), [['remove', '--ignore-scripts', '--', OLD_APP]])
    assert.equal(value.state.dependencies[OLD_APP], undefined)
  })
})

test('a file copy of this local application refreshes to a link without removing it first', async () => {
  await withFixture(async value => {
    mounted(value)
    value.state.dependencies[APP] = `file:${value.packageDirectory}`
    value.resolvedDirectory = value.copyDirectory
    await ensureNativeAttachment(value.options, value.api)
    assert.deepEqual(value.calls.map(call => call.args), [['add', '--ignore-scripts', `link:${value.packageDirectory}`]])
  })
})

test('explicitly disabled application selection is not silently re-enabled', async () => {
  await withFixture(async value => {
    value.state.dependencies[APP] = `link:${value.packageDirectory}`
    const before = structuredClone(value.state)
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /bundle is disabled/)
    assert.deepEqual(value.state, before)
    assert.equal(value.calls.length, 0)
  })
})

test('another selected frontend is refused without installing or deleting anything', async () => {
  await withFixture(async value => {
    value.state.dsh.profile.bundles.push('@deepseek-ai/dsh-web-app')
    const before = structuredClone(value.state)
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /another frontend.*not replaced/)
    assert.deepEqual(value.state, before)
    assert.equal(value.calls.length, 0)
  })
})

test('a different source using the same package name is not replaced', async () => {
  await withFixture(async value => {
    mounted(value)
    value.state.dependencies[APP] = 'file:../another-project'
    value.resolvedDirectory = value.copyDirectory
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /another source.*not replaced/)
    assert.equal(value.calls.length, 0)
  })
})

test('native package exit zero alone is not treated as mounted-application success', async () => {
  await withFixture(async value => {
    value.hook = async () => ({ exitCode: 0 })
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /bundle is not available/)
    assert.equal(value.calls.length, 1)
  })
})

test('unknown package-operation errors are not serialized or echoed', async () => {
  await withFixture(async value => {
    value.hook = async () => { throw { message: 'synthetic-private-marker', token: 'synthetic-token', cause: { password: 'synthetic-password' } } }
    await assert.rejects(ensureNativeAttachment(value.options, value.api), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /plugin management failed/)
      assert.doesNotMatch(error.message, /synthetic|token|password/)
      return true
    })
  })
})

test('native package silence timeouts surface as terminal startup failures', async () => {
  await withFixture(async value => {
    value.hook = async () => ({ exitCode: 1, timedOut: true })
    await assert.rejects(ensureNativeAttachment(value.options, value.api), /timed out/)
    assert.equal(value.calls.length, 1)
  })
})

test('cancellation before attachment performs no package operation', async () => {
  await withFixture(async value => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(ensureNativeAttachment({ ...value.options, signal: controller.signal }, value.api), /cancelled/)
    assert.equal(value.calls.length, 0)
    assert.equal(value.locations.length, 0)
  })
})

test('cancellation during a native operation joins it and never proceeds to old-alias removal', async () => {
  await withFixture(async value => {
    previousApplication(value)
    const controller = new AbortController()
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    let settled = false
    value.hook = async (_args, options) => {
      started()
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
      settled = true
      return { exitCode: 1 }
    }
    const attaching = ensureNativeAttachment({ ...value.options, signal: controller.signal }, value.api)
    await entered
    controller.abort()
    await assert.rejects(attaching, /cancelled/)
    assert.equal(settled, true)
    assert.equal(value.calls.length, 1)
    assert.ok(value.state.dependencies[OLD_APP])
  })
})

test('malformed native metadata fails without attempting a package operation or echoing its contents', async () => {
  await withFixture(async value => {
    value.api.manifest = () => ({ dependencies: 'synthetic-private-field', dsh: { profile: { bundles: [] } } })
    await assert.rejects(ensureNativeAttachment(value.options, value.api), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /package metadata.*No configuration was rewritten/)
      assert.doesNotMatch(error.message, /synthetic-private-field/)
      return true
    })
    assert.equal(value.calls.length, 0)
  })
})

test('profile and explicit home selection are supplied to the native API unchanged', async () => {
  await withFixture(async value => {
    await ensureNativeAttachment({ ...value.options, profile: 'chosen-profile' }, value.api)
    assert.deepEqual(value.locations, [{ profile: 'chosen-profile', home: value.home }])
  })
})
