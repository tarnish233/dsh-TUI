// Hermetic model stream: intercept the public llm/stream waterfall, never call next().
import { setTimeout as delay } from 'node:timers/promises'
export const name = 'dsh-tui-test-stream'
export const inject = ['llm', 'agents', 'approval', 'commands', 'sessionTitle']
const approvals = new Map()
export function apply(ctx) {
  ctx.on('llm/stream', (options, _next) => stream(ctx, options))
  ctx.effect(() => ctx.commands.register({
    definitionId: '@dsh-tui-test/command-wait',
    name: 'fixture-wait', description: 'Hermetic cancellation probe',
    handler: async ({ signal }) => {
      await new Promise(resolve => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { kind: 'error', text: 'Fixture command cancelled.' }
    },
  }), 'hermetic command fixture')
  ctx.effect(() => ctx.commands.register({
    definitionId: '@dsh-tui-test/command-title',
    name: 'fixture-title', description: 'Hermetic native title API probe',
    handler: ({ agent }) => {
      const title = ctx.sessionTitle.rename(agent.session, 'Native fixture title')
      return { kind: 'success', text: title.title }
    },
  }), 'hermetic title fixture')
}
async function* stream(ctx, options) {
  const messages = options.messages ?? []
  const allText = messages.filter(message => message.role === 'user').flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const text = allText.slice(Math.max(0, allText.lastIndexOf('fixture:')))
  let approvalOutcome = approvals.get(options.sessionId)
  if (text.includes('fixture:approval') && !approvalOutcome) {
    const agent = ctx.agents.get(options.sessionId)
    ctx.approval.setPolicy(agent, 'ask')
    approvalOutcome = await ctx.approval.request({ agent, toolName: 'fixture-gate', reason: 'Hermetic approval test; no filesystem action is performed.', signal: options.signal })
    approvals.set(options.sessionId, approvalOutcome)
  }
  const askId = 'fixture-ask-call'
  const answered = messages.some(message => message.role === 'tool' && message.toolCallId === askId)
  if (text.includes('fixture:question') && !answered) {
    const argumentsText = JSON.stringify({ questions: [{ id: 'fixture-choice', question: 'Choose a native fixture answer?', header: 'Fixture', options: [{ label: 'Alpha', description: 'First answer' }, { label: 'Beta', description: 'Second answer' }] }] })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: askId, name: 'ask_user_question', argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: askId, name: 'ask_user_question', arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const readId = 'fixture-native-read'
  const hasRead = messages.some(message => message.role === 'tool' && message.toolCallId === readId)
  if (text.includes('fixture:tool') && !hasRead) {
    const argumentsText = JSON.stringify({ file_path: 'native-output.txt', offset: 1, limit: 160 })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: readId, name: 'read', argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: readId, name: 'read', arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const workspaceFilesId = 'fixture-workspace-normal-file'
  const hasWorkspaceFiles = messages.some(message => message.role === 'tool' && message.toolCallId === workspaceFilesId)
  if (text.includes('fixture:workspace-files') && !hasWorkspaceFiles) {
    // Both writes use the native pipeline in the owned workspace. './ ' is a
    // legal whitespace filename; keeping its native position is essential for
    // later per-file diff indices, even though its display label is blank.
    const files = [
      { id: 'fixture-workspace-whitespace-file', path: './ ', content: 'contents of the whitespace-named file\n' },
      { id: workspaceFilesId, path: 'a.txt', content: 'contents of normal a.txt\n' },
    ]
    for (const [index, file] of files.entries()) {
      const argumentsText = JSON.stringify({ file_path: file.path, content: file.content })
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id: file.id, name: 'write', argumentsDelta: argumentsText }
      yield { type: 'block-end', index, block: { type: 'tool-call', id: file.id, name: 'write', arguments: argumentsText } }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const writeId = 'fixture-native-write'
  const hasWrite = messages.some(message => message.role === 'tool' && message.toolCallId === writeId)
  if (text.includes('fixture:write') && !hasWrite) {
    // One real native write/presentCall pipeline in the owned workspace.
    const argumentsText = JSON.stringify({ file_path: 'native-write.txt', content: 'native new line\n' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: writeId, name: 'write', argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: writeId, name: 'write', arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  const escalatedWriteId = 'fixture-native-write-escalated'
  const hasEscalatedWrite = messages.some(message => message.role === 'tool' && message.toolCallId === escalatedWriteId)
  const writeDenied = messages.some(message => message.role === 'tool' && message.toolCallId === writeId
    && (message.content ?? []).some(block => block.type === 'text' && block.text.includes('escalation available')))
  if (text.includes('fixture:write') && writeDenied && !hasEscalatedWrite) {
    const argumentsText = JSON.stringify({
      file_path: 'native-write.txt', content: 'native new line\n',
      sandbox_permissions: 'workspace-write',
      justification: 'Allow this one fixture write inside the owned temporary workspace.',
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: escalatedWriteId, name: 'write', argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: escalatedWriteId, name: 'write', arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  // This public pruning service is exercised inside the native open turn,
  // not from an idle human command (replacement tool/result has turn scope).
  if (text.includes('fixture:tool') && hasRead) {
    const agent = ctx.agents.get(options.sessionId)
    // Standard/ptc/cordis own this service inside the Agent preset; the host
    // row is disabled so a minimal Agent never inherits pruning.
    const pruner = ctx.get('agentPresets')?.serviceFor?.(agent, 'toolResultPruner')
    if (pruner !== undefined) pruner.pruneSession(agent.session)
  }
  const fragments = text.includes('fixture:slow') ? Array.from({ length: 80 }, (_, index) => 'slow-' + index + ' ') : ['fixture-live ', '中文 ', '🚀 ', approvalOutcome ? 'approval-' + approvalOutcome : answered ? 'question-complete' : 'complete']
  yield { type: 'block-start', index: 0, blockType: 'text' }
  let answer = ''
  for (const fragment of fragments) {
    if (options.signal?.aborted) throw options.signal.reason
    await delay(20, undefined, { signal: options.signal })
    answer += fragment
    yield { type: 'text-delta', index: 0, text: fragment }
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
