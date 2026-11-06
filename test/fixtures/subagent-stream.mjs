// Real DSH subagent lifecycle with hermetic model streams. Two native child
// Agents are delegated together; one completes and one requires native approval.
import { setTimeout as delay } from 'node:timers/promises'
export const name = 'dsh-tui-test-subagent-stream'
export const inject = ['llm', 'agents', 'approval']

export function apply(ctx) {
  ctx.on('llm/stream', options => stream(ctx, options))
}

async function* stream(ctx, options) {
  const messages = options.messages ?? []
  const users = messages.filter(message => message.role === 'user')
  const allText = users.flatMap(message => message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const hasRead = messages.some(message => message.role === 'tool' && message.toolCallId === 'fixture-child-read')
  const hasSpawn = messages.some(message => message.role === 'tool' && (
    message.toolCallId === 'fixture-spawn-complete' ||
    message.toolCallId === 'fixture-spawn-approval' ||
    message.toolCallId === 'fixture-spawn-stop'
  ))

  if (allText.includes('fixture:child-followup')) {
    await delay(150)
    yield* text('native child followup completed')
    return
  }
  if (allText.includes('fixture:child-stop')) {
    await delay(30_000, undefined, { signal: options.signal })
    yield* text('native child should have been interrupted')
    return
  }
  if (allText.includes('fixture:child-complete')) {
    yield* text('native child completed')
    return
  }
  if (allText.includes('fixture:child-approval')) {
    if (!hasRead) {
      const agent = ctx.agents.get(options.sessionId)
      ctx.approval.setPolicy(agent, 'ask')
      await ctx.approval.request({
        agent,
        toolName: 'fixture-child-gate',
        reason: 'Hermetic native child approval; the following read stays inside the temporary workspace.',
        signal: options.signal,
      })
      yield* toolCall(0, 'fixture-child-read', 'read', { file_path: 'native-output.txt', offset: 1, limit: 20 })
      return
    }
    await delay(300)
    yield* text('child approval completed')
    return
  }
  if (allText.includes('fixture:subagent-stop') && !hasSpawn) {
    yield* toolCall(1, 'fixture-spawn-stop', 'subagent', {
      description: 'Child stoppable', prompt: 'fixture:child-stop',
    })
    return
  }
  if (allText.includes('fixture:subagents') && !hasSpawn) {
    yield* toolCall(0, 'fixture-spawn-complete', 'subagent', {
      description: 'Child complete', prompt: 'fixture:child-complete',
    })
    yield* toolCall(1, 'fixture-spawn-approval', 'subagent', {
      description: 'Child approval', prompt: 'fixture:child-approval',
    })
    return
  }
  yield* text('parent observed native child settlement')
}

async function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* toolCall(index, id, name, args) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  if (index === 1 || name === 'read') yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
