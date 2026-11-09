import { Command } from 'commander'
import { resolve } from 'node:path'
import { VERSION } from '../version.ts'

export { VERSION }
export const DEFAULT_PROFILE = 'dsh-tui'
export const STARTUP_SERVICE = 'dshTuiStartup'

/** Terminal preferences and session attachment only; all DSH domain configuration stays native. */
export interface TuiOptions {
  cwd?: string
  screen?: 'inline' | 'fullscreen'
  configDir?: string
  resume?: string
  resumePicker?: boolean
  provider?: string
  model?: string
  demo?: boolean
  initialPrompt?: string
}

export interface TuiFlags {
  inline?: boolean
  fullscreen?: boolean
  cwd?: string
  configDir?: string
  resume?: string | boolean
  provider?: string
  model?: string
  demo?: boolean
  profile?: string
  dsh?: string
  dshHome?: string
}

/** The alias and native startup plugin share one grammar, not two application launchers. */
export function tuiCommand(alias = false): Command {
  const command = new Command()
    .name(alias ? 'dsh-tui' : `dsh --profile ${DEFAULT_PROFILE}`)
    .description('CC-style terminal application plugin for DeepSeek Harness.')
    .version(VERSION, '-v, --version')
    .argument('[prompt...]', 'initial user prompt')
    .option('--demo', 'deterministic offline UI demo, no model calls')
    .option('--inline', 'use main screen / native terminal scrollback instead of fullscreen')
    .option('--fullscreen', 'use fullscreen renderer with app-owned scrolling (default)')
    .option('--cwd <directory>', 'session working directory')
    .option('--model <provider/model>', 'select a native DSH model for this launch')
    .option('--provider <name>', 'native provider when --model contains no provider')
    .option('-r, --resume [id]', 'explicitly resume a session; without an id, open the picker')
    .option('--config-dir <directory>', 'TUI preferences and keybindings directory')
    .addHelpText('after', '\nFullscreen is the default; --inline selects native terminal scrollback.\nSaved screen preferences apply when no screen flag is supplied.\nModels, tools, permissions, credentials and sessions belong to DSH.\nConfigure them through the native DSH profile; Pi auth/catalogs are never read.\n')
  if (alias) command
    .addHelpText('after', 'Offline task showcase: dsh-tui --demo tasks (Todo + Goal + Subagents).\nUse tasks next / tasks done / tasks clear / tasks history inside that demo.\nThe alias attaches this local application through native DSH plugin management when needed.\nOther frontends and explicit bundle disables are never overridden.\n')
    .option('--profile <name>', 'native DSH profile (local application attached automatically)', DEFAULT_PROFILE)
    .option('--dsh <executable>', 'native DSH command/path', 'dsh')
    .option('--dsh-home <directory>', 'DSH native home for this invocation')
  return command
}

export function optionsFromFlags(flags: TuiFlags, prompt: readonly string[], command: Command): TuiOptions {
  if (flags.inline && flags.fullscreen) command.error('Choose --inline or --fullscreen, not both.')
  let model = flags.model
  let provider = flags.provider
  if (model?.includes('/')) {
    const separator = model.indexOf('/')
    provider = model.slice(0, separator)
    model = model.slice(separator + 1)
  }
  const resumePicker = flags.resume === true || flags.resume === ''
  const resume = typeof flags.resume === 'string' && flags.resume.trim() !== '' ? flags.resume : undefined
  return {
    ...(flags.cwd === undefined ? {} : { cwd: resolve(flags.cwd) }),
    ...(flags.fullscreen ? { screen: 'fullscreen' as const } : flags.inline ? { screen: 'inline' as const } : {}),
    ...(flags.configDir === undefined ? {} : { configDir: resolve(flags.configDir) }),
    ...(resume === undefined ? {} : { resume }),
    ...(resumePicker ? { resumePicker: true } : {}),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(flags.demo === undefined ? {} : { demo: flags.demo }),
    ...(prompt.length === 0 ? {} : { initialPrompt: prompt.join(' ') }),
  }
}
