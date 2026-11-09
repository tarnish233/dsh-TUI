/**
 * Offline contract tests for the safe native default-setting read/write.
 *
 * Synthetic Cordis doubles shaped after the public DSH `0.2.2-rc.1`
 * `SettingsForms` / `SettingsDescriptor` / `Loader` / preset rosters. The
 * profile ids are deliberately NOT the web ids (`permission`,
 * `agent-preset-registry`): resolution must come from the public Loader tree.
 * No profile, credential, real document, file write or model call is touched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NativeManagement,
  type NativeDefaultSettingOutcome,
  type NativeDefaultSettingsRead,
} from '../src/backend/native-management.ts'
import type { NativeUiAccess, NativeUiScope } from '../src/backend/native-ui-scope.ts'

const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset-registry'
const PERMISSION_PACKAGE = '@deepseek-ai/dsh-permission-presets'
const PRESET_NS = 'owner-profile-presets'
const PERMISSION_NS = 'owner-profile-permission'
const DECOY_NS = 'owner-profile-provider-credentials'
const SECRET_VALUE = 'sk-live-decoy-never-copy'

/**
 * The ACTUAL native serialized form observed from `SettingsForms.describe()` in
 * the installed public `0.2.2-rc.1`: `{uid, refs}`, root object in `refs`, and
 * a field node whose `meta` is empty because `plainSchema` strips `volatile`.
 */
function nativeFormSchema(field: string): unknown {
  return {
    uid: 7,
    refs: {
      6: { type: 'string', meta: {} },
      7: { type: 'object', meta: { default: {} }, dict: { [field]: 6 } },
    },
  }
}

/** A legacy/defensive shape that still carries the volatile marker. */
function volatileSchema(field: string, extra: Record<string, string> = {}): unknown {
  const dict: Record<string, number> = { [field]: 11 }
  const refs: Record<string, unknown> = {
    10: { type: 'object', meta: {}, dict },
    11: { type: 'string', meta: { volatile: true } },
  }
  let uid = 12
  for (const [name, type] of Object.entries(extra)) {
    dict[name] = uid
    refs[uid] = { type, meta: { volatile: true } }
    uid += 1
  }
  return { uid: 10, refs }
}

interface DescriptorRow {
  readonly ns: string
  readonly schema: unknown
  readonly value: Record<string, unknown>
  readonly revision: number
  readonly secrets?: readonly unknown[]
}

interface MutateCall {
  readonly ns: string
  readonly ops: readonly { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }[]
  readonly expectedRevision: number | undefined
}

/** Native-shaped settings double: exact-path writes, revision fence, untouched neighbours. */
class FakeSettings {
  readonly describeOptions: unknown[] = []
  readonly mutateCalls: MutateCall[] = []
  readonly values: Record<string, Record<string, unknown>> = {
    [PRESET_NS]: { default: 'standard', selectedDefault: undefined, otherLive: 'keep' },
    [PERMISSION_NS]: { defaultPreset: 'read-only', unrelatedLive: 'keep' },
    [DECOY_NS]: { apiKey: SECRET_VALUE },
  }
  readonly revisions: Record<string, number> = { [PRESET_NS]: 2, [PERMISSION_NS]: 5, [DECOY_NS]: 0 }
  describeError: Error | undefined
  failNextWrite: Error | undefined
  /** Simulates another writer advancing the revision between prepare and write. */
  bumpBeforeCheck = false
  /** Simulates a native normalizing write path. */
  transform?: (value: string) => string
  /** Runs while an asynchronous roster read is in flight. */
  onRead?: () => void

  describe(options?: { readonly redactSecrets?: boolean }): unknown {
    this.describeOptions.push(options)
    if (this.describeError !== undefined) throw this.describeError
    const rows: DescriptorRow[] = [
      {
        ns: PRESET_NS,
        schema: volatileSchema('selectedDefault', { otherLive: 'string' }),
        value: {
          selectedDefault: this.values[PRESET_NS]?.selectedDefault,
          // A defence-in-depth decoy: the adapter must copy only the allowlisted scalar.
          otherLive: 'keep',
          injected: SECRET_VALUE,
        },
        revision: this.revisions[PRESET_NS] ?? 0,
        secrets: [{ path: ['apiKey'], set: true }],
      },
      {
        ns: PERMISSION_NS,
        schema: volatileSchema('defaultPreset', { unrelatedLive: 'string' }),
        value: {
          defaultPreset: this.values[PERMISSION_NS]?.defaultPreset,
          unrelatedLive: 'keep',
        },
        revision: this.revisions[PERMISSION_NS] ?? 0,
      },
      {
        ns: DECOY_NS,
        schema: volatileSchema('apiKey'),
        value: { apiKey: SECRET_VALUE },
        revision: this.revisions[DECOY_NS] ?? 0,
        secrets: [{ path: ['apiKey'], set: true }],
      },
    ]
    return rows.map((row) => ({
      ns: row.ns,
      autoGenerate: false,
      schema: row.schema,
      value: row.value,
      base: {},
      user: {},
      revision: row.revision,
      applies: 'live',
      ...(row.secrets === undefined ? {} : { secrets: row.secrets }),
    }))
  }

  async mutate(
    ns: string,
    ops: readonly { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }[],
    expectedRevision?: number,
  ): Promise<unknown> {
    this.mutateCalls.push({ ns, ops, expectedRevision })
    this.onRead?.()
    if (this.failNextWrite !== undefined) {
      const error = this.failNextWrite
      this.failNextWrite = undefined
      throw error
    }
    if (this.bumpBeforeCheck) {
      this.bumpBeforeCheck = false
      this.revisions[ns] = (this.revisions[ns] ?? 0) + 1
    }
    if (expectedRevision !== undefined && expectedRevision !== (this.revisions[ns] ?? 0)) {
      const error = new Error(`settings conflict on "${ns}"`)
      error.name = 'SettingsConflictError'
      Object.assign(error, { code: 'SETTINGS_CONFLICT', expected: expectedRevision, actual: this.revisions[ns] })
      throw error
    }
    const section = this.values[ns] ?? {}
    for (const op of ops) {
      if (op.path.length !== 1) throw new Error(`unexpected path depth ${op.path.length}`)
      const field = op.path[0] ?? ''
      section[field] = typeof op.value === 'string' && this.transform !== undefined ? this.transform(op.value) : op.value
    }
    this.values[ns] = section
    this.revisions[ns] = (this.revisions[ns] ?? 0) + 1
    return undefined
  }
}

interface Host {
  scope: NativeUiScope | undefined
  services: Map<string, unknown>
  warnings: string[]
}

function accessOf(host: Host): NativeUiAccess {
  return {
    host: { synthetic: true },
    service: (name: string): unknown => host.services.get(name),
    current: () => host.scope,
    isCurrent: (scope) => host.scope === scope,
    warn: (message) => host.warnings.push(message),
  }
}

interface Fixture {
  readonly host: Host
  readonly settings: FakeSettings
  readonly loader: { entries(): unknown[] }
  readonly presetListCalls: { count: number }
  readonly presetRoster: unknown[]
  presets?: unknown
  permissions?: unknown
}

function fixture(): Fixture {
  const scope: NativeUiScope = { sessionId: 's1', attachmentId: 'a1' }
  const settings = new FakeSettings()
  const presetListCalls = { count: 0 }
  const presetRoster: unknown[] = [
    { id: 'standard', name: 'Standard' },
    { id: 'ptc', name: 'PTC mode', description: 'batch tools' },
    { id: 'broken-one', name: 'Broken', broken: 'load failed' },
  ]
  const state: Fixture = {
    host: { scope, services: new Map(), warnings: [] },
    settings,
    loader: {
      entries: () => [
        { options: { id: PERMISSION_NS, name: PERMISSION_PACKAGE } },
        { options: { id: PRESET_NS, name: PRESET_PACKAGE } },
        { options: { id: DECOY_NS, name: '@deepseek-ai/dsh-llm-deepseek' } },
      ],
    },
    presetListCalls,
    presetRoster,
    presets: {
      defaultId: 'standard',
      list: async (): Promise<unknown> => {
        presetListCalls.count += 1
        settings.onRead?.()
        return presetRoster
      },
    },
    permissions: {
      catalog: () => ({
        options: [],
        defaultOptions: [
          { value: 'read-only', name: 'Read only' },
          { value: 'workspace-write', name: 'Workspace write', description: 'edit the workspace' },
          { value: 'danger-full-access', name: 'Full access' },
        ],
        defaultPreset: 'workspace-write',
      }),
    },
  }
  state.host.services.set('settings', settings)
  state.host.services.set('loader', state.loader)
  state.host.services.set('agentPresets', state.presets)
  state.host.services.set('permissionPresets', state.permissions)
  return state
}

function adapterOf(state: Fixture): NativeManagement {
  return new NativeManagement({ access: accessOf(state.host) })
}

function target(read: NativeDefaultSettingsRead, target: string): NativeDefaultSettingsRead['targets'][number] {
  const found = read.targets.find((view) => view.target === target)
  assert.ok(found, `missing target ${target}`)
  return found
}

// ---------------------------------------------------------------------------
// safe read
// ---------------------------------------------------------------------------

test('defaults resolve the profile-owned namespace ids from the public Loader and project only the allowlist', async () => {
  const state = fixture()
  const read = await adapterOf(state).defaultSettings()
  assert.equal(read.available, true)
  assert.equal(read.targets.length, 2)
  assert.equal(state.presetListCalls.count, 1)
  assert.deepEqual(state.settings.describeOptions, [{ redactSecrets: true }])

  const presets = target(read, 'agent-preset-default')
  assert.equal(presets.available, true)
  assert.equal(presets.writable, true)
  assert.equal(presets.namespace, PRESET_NS)
  assert.equal(presets.field, 'selectedDefault')
  assert.equal(presets.value, undefined)
  assert.equal(presets.effectiveValue, 'standard')
  assert.equal(presets.revision, 2)
  assert.deepEqual(presets.options.map((option) => option.id), ['standard', 'ptc'])
  assert.equal(presets.options[1]?.label, 'PTC mode')

  const permission = target(read, 'permission-default-preset')
  assert.equal(permission.namespace, PERMISSION_NS)
  assert.equal(permission.field, 'defaultPreset')
  assert.equal(permission.value, 'read-only')
  assert.equal(permission.effectiveValue, 'workspace-write')
  assert.equal(permission.revision, 5)
  assert.deepEqual(permission.options.map((option) => option.id), ['read-only', 'workspace-write', 'danger-full-access'])

  const serialized = JSON.stringify(read)
  assert.doesNotMatch(serialized, /sk-live-decoy/)
  assert.doesNotMatch(serialized, /apiKey/)
  assert.doesNotMatch(serialized, /otherLive/)
  assert.doesNotMatch(serialized, /injected/)
  assert.doesNotMatch(serialized, /secrets/)
  assert.doesNotMatch(serialized, new RegExp(DECOY_NS))
})

test('an ambiguous, missing or unexposed namespace fails closed', async () => {
  const ambiguous = fixture()
  ambiguous.loader.entries = (): unknown[] => [
    { options: { id: PRESET_NS, name: PRESET_PACKAGE } },
    { options: { id: 'second-preset-owner', name: PRESET_PACKAGE } },
  ]
  const ambiguousRead = await adapterOf(ambiguous).defaultSettings()
  const ambiguousTarget = target(ambiguousRead, 'agent-preset-default')
  assert.equal(ambiguousTarget.available, false)
  assert.equal(ambiguousTarget.writable, false)
  assert.equal(ambiguousTarget.reason, 'namespace-ambiguous')
  assert.equal(ambiguous.settings.mutateCalls.length, 0)

  const missing = fixture()
  missing.loader.entries = (): unknown[] => []
  const missingRead = await adapterOf(missing).defaultSettings()
  assert.equal(target(missingRead, 'agent-preset-default').reason, 'namespace-unresolved')

  const unexposed = fixture()
  const hidden = unexposed.settings.describe.bind(unexposed.settings)
  unexposed.settings.describe = (options?: { readonly redactSecrets?: boolean }): unknown =>
    (hidden(options) as readonly Record<string, unknown>[]).filter((row) => row.ns !== PRESET_NS)
  const unexposedRead = await adapterOf(unexposed).defaultSettings()
  assert.equal(target(unexposedRead, 'agent-preset-default').reason, 'namespace-unavailable')
})

test('the actual native volatile-only form (marker stripped, field unset) proves the allowlisted field', async () => {
  const state = fixture()
  const describe = state.settings.describe.bind(state.settings)
  state.settings.describe = (options?: { readonly redactSecrets?: boolean }): unknown => {
    const rows = describe(options) as readonly Record<string, unknown>[]
    return rows.map((row) => row.ns === PRESET_NS
      ? { ...row, schema: nativeFormSchema('selectedDefault'), value: {} }
      : row.ns === PERMISSION_NS
        ? { ...row, schema: nativeFormSchema('defaultPreset'), value: {} }
        : row)
  }
  const read = await adapterOf(state).defaultSettings()
  const presets = target(read, 'agent-preset-default')
  assert.equal(presets.available, true)
  assert.equal(presets.field, 'selectedDefault')
  assert.equal(presets.value, undefined)
  assert.equal(presets.revision, 2)
  assert.equal(presets.writable, true)
  assert.equal(presets.effectiveValue, 'standard')
  assert.deepEqual(presets.options.map((option) => option.id), ['standard', 'ptc'])
  const permission = target(read, 'permission-default-preset')
  assert.equal(permission.available, true)
  assert.equal(permission.value, undefined)
  assert.equal(permission.revision, 5)
  assert.equal(permission.effectiveValue, 'workspace-write')
})

test('descriptor selection and proof never depend on the field being present in value/user', async () => {
  const state = fixture()
  const describe = state.settings.describe.bind(state.settings)
  state.settings.describe = (options?: { readonly redactSecrets?: boolean }): unknown => {
    const rows = describe(options) as readonly Record<string, unknown>[]
    return rows.map((row) => row.ns === PRESET_NS
      // The value carries the decoy field and a secret, but the native form does
      // not declare it: value presence must never promote a field.
      ? { ...row, schema: nativeFormSchema('someOtherField'), value: { selectedDefault: 'ptc' } }
      : row)
  }
  const read = await adapterOf(state).defaultSettings()
  const presets = target(read, 'agent-preset-default')
  assert.equal(presets.available, false)
  assert.equal(presets.reason, 'field-not-volatile')
  assert.equal(JSON.stringify(read).includes('ptc'), false)
})

test('an unresolvable field ref or an explicit volatile:false fails closed', async () => {
  const unresolvable = fixture()
  const describe = unresolvable.settings.describe.bind(unresolvable.settings)
  unresolvable.settings.describe = (options?: { readonly redactSecrets?: boolean }): unknown => {
    const rows = describe(options) as readonly Record<string, unknown>[]
    return rows.map((row) => row.ns === PRESET_NS
      ? { ...row, schema: { uid: 7, refs: { 7: { type: 'object', meta: {}, dict: { selectedDefault: 99 } } } } }
      : row)
  }
  const unresolvableRead = await adapterOf(unresolvable).defaultSettings()
  assert.equal(target(unresolvableRead, 'agent-preset-default').reason, 'field-not-volatile')

  const refused = fixture()
  const refusedDescribe = refused.settings.describe.bind(refused.settings)
  refused.settings.describe = (options?: { readonly redactSecrets?: boolean }): unknown => {
    const rows = refusedDescribe(options) as readonly Record<string, unknown>[]
    return rows.map((row) => row.ns === PRESET_NS
      ? { ...row, schema: { uid: 7, refs: { 6: { type: 'string', meta: { volatile: false } }, 7: { type: 'object', meta: {}, dict: { selectedDefault: 6 } } } } }
      : row)
  }
  const refusedRead = await adapterOf(refused).defaultSettings()
  assert.equal(target(refusedRead, 'agent-preset-default').reason, 'field-not-volatile')
})

test('a non-string stored value is refused rather than coerced', async () => {
  const state = fixture()
  state.settings.values[PERMISSION_NS] = { defaultPreset: 42 }
  const read = await adapterOf(state).defaultSettings()
  const permission = target(read, 'permission-default-preset')
  assert.equal(permission.available, false)
  assert.equal(permission.reason, 'value-malformed')
  assert.equal(permission.value, undefined)
})

test('an unreadable native roster makes that target read-only, never an empty authoritative list', async () => {
  const state = fixture()
  state.host.services.delete('agentPresets')
  const read = await adapterOf(state).defaultSettings()
  const presets = target(read, 'agent-preset-default')
  assert.equal(presets.available, true)
  assert.equal(presets.writable, false)
  assert.equal(presets.reason, 'options-unavailable')
  assert.deepEqual(presets.options, [])
  assert.equal(target(read, 'permission-default-preset').writable, true)

  const failing = fixture()
  failing.presets = {
    defaultId: 'standard',
    list: async (): Promise<unknown> => {
      throw new Error('roster unavailable (Authorization: Bearer sk-roster-roster)')
    },
  }
  failing.host.services.set('agentPresets', failing.presets)
  const failed = await adapterOf(failing).defaultSettings()
  assert.equal(target(failed, 'agent-preset-default').reason, 'options-unavailable')
  assert.match(failing.host.warnings.join('\n'), /\[redacted\]/)
  assert.doesNotMatch(failing.host.warnings.join('\n'), /sk-roster-roster/)
})

test('missing settings, no attachment and an unreadable descriptor are distinct read reasons', async () => {
  const noSettings = fixture()
  noSettings.host.services.delete('settings')
  assert.equal((await adapterOf(noSettings).defaultSettings()).reason, 'missing-settings-service')

  const noAttachment = fixture()
  noAttachment.host.scope = undefined
  assert.equal((await adapterOf(noAttachment).defaultSettings()).reason, 'no-attachment')

  const failed = fixture()
  failed.settings.describeError = new Error('descriptor exploded')
  const read = await adapterOf(failed).defaultSettings()
  assert.equal(read.available, false)
  assert.equal(read.reason, 'read-failed')
  assert.equal(failed.host.warnings.length, 1)
})

// ---------------------------------------------------------------------------
// explicit confirmed write
// ---------------------------------------------------------------------------

test('a confirmed write sends exactly one allowlisted path with the native revision and preserves neighbours', async () => {
  const state = fixture()
  const adapter = adapterOf(state)
  const before = await adapter.defaultSettings()
  const presets = target(before, 'agent-preset-default')
  assert.equal(presets.revision, 2)

  const outcome = await adapter.updateDefault({
    target: 'agent-preset-default',
    value: 'ptc',
    expectedRevision: 2,
    attachmentId: 'a1',
  })
  assert.equal(outcome.ok, true)
  const ok = outcome as Extract<NativeDefaultSettingOutcome, { ok: true }>
  assert.equal(ok.namespace, PRESET_NS)
  assert.equal(ok.field, 'selectedDefault')
  assert.equal(ok.value, 'ptc')
  assert.equal(ok.changed, true)
  assert.equal(ok.revision, 3)
  assert.equal(ok.attachmentId, 'a1')
  assert.equal(ok.stillCurrent, true)

  assert.equal(state.settings.mutateCalls.length, 1)
  const call = state.settings.mutateCalls[0]
  assert.equal(call?.ns, PRESET_NS)
  assert.deepEqual(call?.ops, [{ op: 'set', path: ['selectedDefault'], value: 'ptc' }])
  assert.equal(call?.expectedRevision, 2)
  // Unrelated settings and the decoy namespace are untouched.
  assert.deepEqual(state.settings.values[PRESET_NS], { default: 'standard', selectedDefault: 'ptc', otherLive: 'keep' })
  assert.deepEqual(state.settings.values[PERMISSION_NS], { defaultPreset: 'read-only', unrelatedLive: 'keep' })
  assert.deepEqual(state.settings.values[DECOY_NS], { apiKey: SECRET_VALUE })
  assert.equal(state.settings.revisions[DECOY_NS], 0)
  // Every read asked for redaction.
  for (const options of state.settings.describeOptions) assert.deepEqual(options, { redactSecrets: true })
})

test('a stale confirmed revision is a conflict before any native write', async () => {
  const state = fixture()
  const outcome = await adapterOf(state).updateDefault({
    target: 'agent-preset-default',
    value: 'ptc',
    expectedRevision: 1,
  })
  assert.equal(outcome.ok, false)
  const failure = outcome as Extract<NativeDefaultSettingOutcome, { ok: false }>
  assert.equal(failure.reason, 'conflict')
  assert.equal(failure.expectedRevision, 1)
  assert.equal(failure.actualRevision, 2)
  assert.equal(failure.current?.revision, 2)
  assert.equal(state.settings.mutateCalls.length, 0)
})

test('a native conflict during the write carries expected/actual and a fresh native view', async () => {
  const state = fixture()
  state.settings.bumpBeforeCheck = true
  const outcome = await adapterOf(state).updateDefault({
    target: 'agent-preset-default',
    value: 'ptc',
    expectedRevision: 2,
  })
  assert.equal(outcome.ok, false)
  const failure = outcome as Extract<NativeDefaultSettingOutcome, { ok: false }>
  assert.equal(failure.reason, 'conflict')
  assert.equal(failure.expectedRevision, 2)
  assert.equal(failure.actualRevision, 3)
  assert.equal(failure.current?.revision, 3)
  assert.equal(state.settings.mutateCalls.length, 1)
  assert.equal(state.settings.values[PRESET_NS]?.selectedDefault, undefined)
})

test('a native write failure is redacted and never reported as a success', async () => {
  const state = fixture()
  state.settings.failNextWrite = new Error('write denied (Authorization: Bearer sk-write-write)')
  const outcome = await adapterOf(state).updateDefault({
    target: 'permission-default-preset',
    value: 'workspace-write',
    expectedRevision: 5,
  })
  assert.equal(outcome.ok, false)
  const failure = outcome as Extract<NativeDefaultSettingOutcome, { ok: false }>
  assert.equal(failure.reason, 'write-failed')
  assert.match(failure.message ?? '', /\[redacted\]/)
  assert.doesNotMatch(failure.message ?? '', /sk-write-write/)
  assert.equal(state.settings.values[PERMISSION_NS]?.defaultPreset, 'read-only')
})

test('a value outside the native roster is refused before any native call', async () => {
  const state = fixture()
  const outcome = await adapterOf(state).updateDefault({
    target: 'agent-preset-default',
    value: 'not-a-preset',
    expectedRevision: 2,
  })
  assert.equal(outcome.ok, false)
  const failure = outcome as Extract<NativeDefaultSettingOutcome, { ok: false }>
  assert.equal(failure.reason, 'not-an-option')
  assert.equal(state.settings.mutateCalls.length, 0)

  const broken = await adapterOf(state).updateDefault({
    target: 'agent-preset-default',
    value: 'broken-one',
    expectedRevision: 2,
  })
  assert.equal(broken.ok, false)
  assert.equal((broken as Extract<NativeDefaultSettingOutcome, { ok: false }>).reason, 'not-an-option')
})

test('the attachment fence invalidates a read and a write with no native call', async () => {
  const reading = fixture()
  reading.host.scope = { sessionId: 's1', attachmentId: 'a1' }
  reading.settings.onRead = (): void => {
    reading.host.scope = { sessionId: 's1', attachmentId: 'a2' }
  }
  const read = await adapterOf(reading).defaultSettings()
  assert.equal(read.available, false)
  assert.equal(read.reason, 'stale-attachment')

  const writing = fixture()
  writing.host.scope = { sessionId: 's1', attachmentId: 'a1' }
  writing.settings.onRead = (): void => {
    writing.host.scope = { sessionId: 's1', attachmentId: 'a2' }
  }
  const outcome = await adapterOf(writing).updateDefault({
    target: 'agent-preset-default',
    value: 'ptc',
    expectedRevision: 2,
    attachmentId: 'a1',
  })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as Extract<NativeDefaultSettingOutcome, { ok: false }>).reason, 'stale-attachment')
  assert.equal(writing.settings.mutateCalls.length, 0)
})

test('a native-normalizing write is reported truthfully as unchanged', async () => {
  const state = fixture()
  state.settings.transform = (value: string): string => value.toLowerCase()
  const outcome = await adapterOf(state).updateDefault({
    target: 'agent-preset-default',
    value: 'PTC',
    expectedRevision: 2,
  })
  // 'PTC' is not a native option id either, so the native roster refuses first.
  assert.equal(outcome.ok, false)
  assert.equal((outcome as Extract<NativeDefaultSettingOutcome, { ok: false }>).reason, 'not-an-option')

  const renamed = fixture()
  renamed.presetRoster.push({ id: 'MixedCase', name: 'Mixed' })
  renamed.settings.transform = (value: string): string => value.toLowerCase()
  const normalized = await adapterOf(renamed).updateDefault({
    target: 'agent-preset-default',
    value: 'MixedCase',
    expectedRevision: 2,
  })
  assert.equal(normalized.ok, true)
  const ok = normalized as Extract<NativeDefaultSettingOutcome, { ok: true }>
  assert.equal(ok.value, 'mixedcase')
  assert.equal(ok.changed, false)
})

test('unmounted services refuse an explicit write without touching the document', async () => {
  const noMutate = fixture()
  noMutate.host.services.set('settings', { describe: noMutate.settings.describe.bind(noMutate.settings) })
  const readOnly = await adapterOf(noMutate).updateDefault({
    target: 'permission-default-preset',
    value: 'workspace-write',
    expectedRevision: 5,
  })
  assert.equal(readOnly.ok, false)
  assert.equal((readOnly as Extract<NativeDefaultSettingOutcome, { ok: false }>).reason, 'unavailable')

  const noLoader = fixture()
  noLoader.host.services.delete('loader')
  const unresolved = await adapterOf(noLoader).updateDefault({
    target: 'permission-default-preset',
    value: 'workspace-write',
    expectedRevision: 5,
  })
  assert.equal(unresolved.ok, false)
  assert.equal((unresolved as Extract<NativeDefaultSettingOutcome, { ok: false }>).reason, 'unavailable')

  const noAttachment = fixture()
  noAttachment.host.scope = undefined
  const stale = await adapterOf(noAttachment).updateDefault({
    target: 'permission-default-preset',
    value: 'workspace-write',
    expectedRevision: 5,
  })
  assert.equal(stale.ok, false)
  assert.equal((stale as Extract<NativeDefaultSettingOutcome, { ok: false }>).reason, 'stale-attachment')
  assert.equal(noAttachment.settings.mutateCalls.length, 0)
})

test('an invalid write contract is rejected as a programming error before any native read', async () => {
  const state = fixture()
  const adapter = adapterOf(state)
  await assert.rejects(
    adapter.updateDefault({ target: 'nope' as never, value: 'x', expectedRevision: 1 }),
    /unknown native default-setting target/,
  )
  await assert.rejects(
    adapter.updateDefault({ target: 'agent-preset-default', value: '', expectedRevision: 1 }),
    /non-empty native option id/,
  )
  await assert.rejects(
    adapter.updateDefault({ target: 'agent-preset-default', value: 'ptc', expectedRevision: -1 }),
    /confirmed native revision/,
  )
  assert.equal(state.settings.describeOptions.length, 0)
  assert.equal(state.settings.mutateCalls.length, 0)
})