import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd, parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { optionsFromFlags, STARTUP_SERVICE, tuiCommand, type TuiOptions, type TuiFlags } from './options.ts'

export const name = 'dsh-tui-startup'
export const inject = ['cmdlineArgs']
export const provide = STARTUP_SERVICE

export interface TuiStartup {
  readonly options: TuiOptions
}

/** DSH owns argument handoff, readiness, EOF and bounded process shutdown. */
export function apply(ctx: Context): void {
  const command = tuiCommand()
  command.action((prompt: string[]) => {
    const options = optionsFromFlags(command.opts<TuiFlags>(), prompt, command)
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      command.error('dsh-tui requires an interactive terminal.', { exitCode: 2 })
    }
    exitOnStdinEnd(ctx, 'dsh-tui.stdin')
    ctx.provide(STARTUP_SERVICE, { options } satisfies TuiStartup)
    const ready = ctx.appReady
    if (ready === undefined) throw new Error('dsh-tui requires the native DSH application readiness service')
    ctx.effect(() => ready.onReady(() => {
      // A refused/missing TUI row must not silently leave a successful headless profile.
      if (ctx.get('dshTui') === undefined) {
        ctx.logger.error('The dsh-tui terminal plugin did not activate; check native DSH startup diagnostics.')
        ctx.appExit?.(1)
      }
    }), 'dsh-tui.activation')
  })
  parseCmdline(ctx, command)
}
