// Hermetic native model fixture: long Thinking, a controlled handoff, run_code.
export const name = 'dsh-tui-render-handoff-stream'
export const inject = ['llm']
export const state = { ready: false, released: false }
let releaseWaiter
export function release() { state.released = true; releaseWaiter?.(); releaseWaiter = undefined }
export function apply(ctx) {
  ctx.on('llm/stream', (options, _next) => stream(options))
}
async function* stream(options) {
  const messages = options.messages ?? []
  const answered = messages.some(message => message.role === 'tool' && message.toolCallId === 'render-handoff-call')
  if (!answered) {
    const thinking = Array.from({ length: 1400 }, (_, index) => `NATIVE_THINKING_${index}`).join('\n')
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: thinking }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } }
    state.ready = true
    await new Promise((resolve, reject) => {
      if (state.released) { resolve(); return }
      const abort = () => { releaseWaiter = undefined; reject(options.signal?.reason ?? new Error('fixture aborted')) }
      releaseWaiter = () => { options.signal?.removeEventListener('abort', abort); resolve() }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
    })
    const args = JSON.stringify({ code: 'return 42', description: 'Return a constant for the native rendering acceptance fixture' })
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: 'render-handoff-call', name: 'run_code', argumentsDelta: args.slice(0, 12) }
    yield { type: 'tool-call-delta', index: 1, id: 'render-handoff-call', name: 'run_code', argumentsDelta: args.slice(12) }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'render-handoff-call', name: 'run_code', arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return
  }
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'NATIVE_RENDER_HANDOFF_COMPLETE' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'NATIVE_RENDER_HANDOFF_COMPLETE' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
