// Hermetic native skill acceptance: observe public prepared model input, never call a provider/next().
import { setTimeout as delay } from 'node:timers/promises'
export const name = 'dsh-tui-skills-offline-stream'
export const inject = ['llm']
export const observations = []

export function apply(ctx) {
  ctx.on('llm/stream', (options, _next) => stream(options))
}

async function* stream(options) {
  observations.push({
    sessionId: options.sessionId,
    purpose: options.purpose,
    texts: (options.messages ?? []).flatMap(message =>
      Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text)
        : []),
  })
  // Only native pre-step may produce this canonical block. A truncated input
  // such as /skill-stu must not be mistaken for a completed Enter selection.
  const hasSkillStudio = observations.at(-1).texts.some(text => text.includes('<skill_content name="skill-studio">'))
  const text = hasSkillStudio ? 'NATIVE_SKILL_STUDIO_ENTER_RESPONSE' : 'NATIVE_SKILL_OFFLINE_RESPONSE'
  yield { type: 'block-start', index: 0, blockType: 'text' }
  await delay(15, undefined, { signal: options.signal })
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
