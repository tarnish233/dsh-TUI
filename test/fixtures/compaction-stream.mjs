// Hermetic provider that requires the normal turn's explicit reasoning effort
// for compaction too. No transport, credentials or durable user state is used.
export const name = 'dsh-tui-test-compaction-stream'
export const inject = ['llm']

export function apply(ctx) {
  const requests = []
  ctx.provide('compactionFixture', { requests })
  ctx.on('llm/stream', options => stream(options, requests))
}

async function* stream(options, requests) {
  requests.push(options)
  if (options.purpose === 'compaction') {
    if (options.reasoningEffort !== 'high') {
      throw new Error('400 InvalidParameter: The value of the enable_thinking parameter is restricted to True.')
    }
    yield* text('A concise native checkpoint of the long fixture conversation, retaining the user goal and the completed ordinary answer.')
    return
  }
  yield* text('Ordinary answer completed with the explicitly selected reasoning effort.')
}

async function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
