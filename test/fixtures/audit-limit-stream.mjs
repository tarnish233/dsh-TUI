// Fixture only: real native max-tokens semantics, no provider/next()/network.
export const name = 'dsh-tui-audit-limit-stream'
export const inject = ['llm']
export function apply(ctx) {
  ctx.on('llm/stream', (options, _next) => stream(options))
}
async function* stream(options) {
  if (options.signal?.aborted) throw options.signal.reason
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'NATIVE_OUTPUT_LIMIT_REPLY' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_OUTPUT_LIMIT_REPLY' } }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}
