/** Validate neutral read responses at the App boundary; never interpret native policy. */
import type { GoalRead, JobsRead, JobOutputRead, PluginInventoryRead, ToolCatalogRead, WorkingDirectoryRead } from './backend/native-inspection.ts'
import type { ContinuedQuestionsView } from './backend/native-questions.ts'
import type { NativeDefaultSettingsRead } from './backend/native-management.ts'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const number = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0
const string = (value: unknown): boolean => typeof value === 'string'
const optionalString = (value: unknown): boolean => value === undefined || string(value)
const optionalNumber = (value: unknown): boolean => value === undefined || number(value)
const inspectionReasons = new Set(['no-attachment', 'stale-attachment', 'missing-service', 'native-failed', 'malformed', 'no-session', 'no-agent', 'invalid-request'])
const unavailable = (value: Record<string, unknown>): boolean => value.available === false && typeof value.reason === 'string' && inspectionReasons.has(value.reason)
const snapshot = (value: Record<string, unknown>): boolean => value.available === true && typeof value.complete === 'boolean' && typeof value.sessionId === 'string'
const phases = new Set(['running', 'stopping', 'completed', 'killed', 'failed', 'unknown'])
const goalPhases = new Set(['active', 'paused', 'blocked', 'complete'])
const fiberPhases = new Set(['pending', 'loading', 'active', 'failed', 'unloading'])
const job = (value: unknown): boolean => {
  const row = object(value), output = object(row?.output)
  return row !== undefined && string(row.id) && string(row.kind) && string(row.label) &&
    typeof row.status === 'string' && phases.has(row.status) && typeof row.owned === 'boolean' && number(row.startedAt) &&
    optionalNumber(row.finishedAt) && optionalString(row.progress) && optionalString(row.detail) &&
    output !== undefined && number(output.total) && number(output.earliest) && typeof output.evicted === 'boolean'
}

export function readNativeJobs(value: unknown): JobsRead | undefined {
  const row = object(value)
  return row !== undefined && (unavailable(row) || (snapshot(row) && Array.isArray(row.jobs) && row.jobs.every(job)))
    ? value as JobsRead : undefined
}

export function readNativeJobOutput(value: unknown): JobOutputRead | undefined {
  const row = object(value)
  if (row === undefined) return undefined
  if (unavailable(row)) return value as JobOutputRead
  if (!snapshot(row) || !job(row.job) || !number(row.from) || !number(row.next) || typeof row.lossy !== 'boolean' ||
      typeof row.truncated !== 'boolean' || !Array.isArray(row.chunks)) return undefined
  if (!row.chunks.every(value => {
    const chunk = object(value)
    return chunk !== undefined && number(chunk.at) && string(chunk.text) &&
      (chunk.channel === undefined || chunk.channel === 'stdout' || chunk.channel === 'stderr' || chunk.channel === 'log') &&
      (chunk.gapBefore === undefined || chunk.gapBefore === true)
  })) return undefined
  return value as JobOutputRead
}

export function readNativeGoal(value: unknown): GoalRead | undefined {
  const row = object(value)
  if (row === undefined) return undefined
  if (unavailable(row)) return value as GoalRead
  if (!snapshot(row)) return undefined
  if (row.goal === null) return value as GoalRead
  const goal = object(row.goal), blocked = object(goal?.blockedReason)
  if (goal === undefined || !string(goal.id) || !number(goal.revision) || !string(goal.objective) ||
      typeof goal.phase !== 'string' || !goalPhases.has(goal.phase) || !number(goal.maxGoalRounds) || !number(goal.roundsStarted) ||
      !optionalNumber(goal.createdAt) || !optionalNumber(goal.updatedAt) ||
      (goal.activation !== undefined && goal.activation !== 'armed' && goal.activation !== 'disarmed') ||
      (goal.blockedReason !== undefined && (blocked === undefined || !string(blocked.code) || !string(blocked.message)))) return undefined
  return value as GoalRead
}

export function readNativeDirectory(value: unknown): WorkingDirectoryRead | undefined {
  const row = object(value)
  return row !== undefined && (unavailable(row) || (snapshot(row) && optionalString(row.workspaceCwd) &&
    optionalString(row.effectiveCwd) && (row.recordedCwd === null || optionalString(row.recordedCwd)) && typeof row.redirected === 'boolean'))
    ? value as WorkingDirectoryRead : undefined
}

export function readNativePlugins(value: unknown): PluginInventoryRead | undefined {
  const row = object(value)
  if (row === undefined) return undefined
  if (unavailable(row)) return value as PluginInventoryRead
  const summary = object(row.summary)
  if (row.available !== true || typeof row.complete !== 'boolean' || !Array.isArray(row.entries) || summary === undefined ||
      !['total', 'enabled', 'disabled', 'active', 'failed', 'pending', 'malformed'].every(key => number(summary[key])) ||
      !row.entries.every(value => {
        const entry = object(value)
        return entry !== undefined && string(entry.entryId) && string(entry.moduleName) && typeof entry.enabled === 'boolean' &&
          (entry.fiberPhase === null || (typeof entry.fiberPhase === 'string' && fiberPhases.has(entry.fiberPhase)))
      }) || !Array.isArray(row.diagnostics) || !row.diagnostics.every(value => {
        const diagnostic = object(value)
        return diagnostic !== undefined && string(diagnostic.entryId) && string(diagnostic.message)
      }) || typeof row.diagnosticsTruncated !== 'boolean') return undefined
  return value as PluginInventoryRead
}

export function readNativeTools(value: unknown): ToolCatalogRead | undefined {
  const row = object(value)
  if (row === undefined) return undefined
  if (unavailable(row)) return value as ToolCatalogRead
  const summary = object(row.summary)
  if (!snapshot(row) || !Array.isArray(row.tools) || summary === undefined ||
      !['total', 'executable', 'deferred'].every(key => number(summary[key])) || !row.tools.every(value => {
        const tool = object(value), presenter = object(tool?.presenter)
        return tool !== undefined && string(tool.name) && string(tool.description) && typeof tool.executable === 'boolean' &&
          typeof tool.deferredLoading === 'boolean' && presenter !== undefined && typeof presenter.call === 'boolean' && typeof presenter.result === 'boolean'
      })) return undefined
  return value as ToolCatalogRead
}

export function readContinuedQuestions(value: unknown): ContinuedQuestionsView | undefined {
  const row = object(value)
  if (row === undefined || !string(row.sessionId) || !optionalString(row.attachmentId) || typeof row.available !== 'boolean' ||
      !Array.isArray(row.active) || !Array.isArray(row.settled) || !optionalNumber(row.asOfSeq)) return undefined
  if (!row.active.every(value => {
    const call = object(value)
    return call !== undefined && string(call.callId) && (call.state === 'open' || call.state === 'continued') &&
      (call.replyQueued === undefined || typeof call.replyQueued === 'boolean') && Array.isArray(call.questions) && call.questions.every(value => {
        const q = object(value)
        return q !== undefined && string(q.id) && string(q.question) && optionalString(q.header) && optionalString(q.detail) &&
          (q.multiSelect === undefined || typeof q.multiSelect === 'boolean') && (q.options === undefined || (Array.isArray(q.options) && q.options.every(value => {
            const option = object(value)
            return option !== undefined && string(option.label) && optionalString(option.description)
          })))
      })
  })) return undefined
  return value as ContinuedQuestionsView
}

export function readNativeDefaults(value: unknown): NativeDefaultSettingsRead | undefined {
  const row = object(value)
  if (row === undefined || typeof row.available !== 'boolean' || !Array.isArray(row.targets) || !optionalString(row.limitation)) return undefined
  const option = (value: unknown): boolean => {
    const row = object(value)
    return row !== undefined && string(row.id) && optionalString(row.label) && optionalString(row.description)
  }
  if (!row.targets.every(value => {
    const target = object(value)
    return target !== undefined && (target.target === 'agent-preset-default' || target.target === 'permission-default-preset' || target.target === 'agent-default-model') &&
      string(target.field) && typeof target.available === 'boolean' && typeof target.writable === 'boolean' &&
      optionalString(target.namespace) && optionalString(target.value) && optionalString(target.effectiveValue) && optionalNumber(target.revision) &&
      optionalString(target.limitation) && Array.isArray(target.options) && target.options.every(option) &&
      optionalString(target.provider) && optionalString(target.model) && optionalString(target.reasoningEffort) &&
      optionalString(target.defaultReasoningEffort) && optionalString(target.effectiveReasoningEffort) &&
      (target.reasoningAvailable === undefined || typeof target.reasoningAvailable === 'boolean') &&
      (target.reasoningSupported === undefined || typeof target.reasoningSupported === 'boolean') &&
      (target.reasoningEfforts === undefined || (Array.isArray(target.reasoningEfforts) && target.reasoningEfforts.every(option)))
  })) return undefined
  return value as NativeDefaultSettingsRead
}
