import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-tui-launcher-check'
export const inject = ['cmdlineArgs']

/** Alias-owned native overlay: even a disabled whole app must fail visibly at startup. */
export function apply(ctx: Context): void {
  const ready = ctx.appReady
  if (ready === undefined || ctx.appExit === undefined) throw new Error('dsh-tui requires native DSH readiness and application-exit services.')
  ctx.effect(() => ready.onReady(() => {
    if (ctx.get('dshTui') !== undefined) return
    // No dsh-tui renderer exists when its service never activated.
    process.stderr.write('dsh-tui: the selected native profile did not activate the terminal application. Check explicit startup/terminal disables and native DSH startup diagnostics; no frontend was replaced.\n')
    ctx.appExit?.(1)
  }), 'dsh-tui.launcher-activation')
}
