import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import type { App } from './app.ts'

const HELP = `dsh-tui 0.1.0 — DSH TUI: CC-style terminal for DeepSeek Harness

Usage: dsh-tui [options] [prompt]

  --demo                  Deterministic offline demo, no model calls
  --inline                Main screen / native terminal scrollback (default)
  --fullscreen            Fullscreen renderer with app-owned scrolling
  --cwd <directory>       Working directory
  --profile <name>        Reuse a real DSH profile: its native providers, model
                          defaults and credentials (dsh --profile <name>)
  --model <provider/model> Override DSH route for this launch
  --provider <name>       Provider (when model does not include a provider)
  --dsh <executable>      DSH command/path (default: dsh on PATH)
  --dsh-home <directory>  DSH native home; the generated profile stays private
  -r, --resume <id>       Resume a DSH session
  -c, --continue          Resume newest-created session in this working directory
  --config-dir <directory> Independent TUI preferences / keybindings
  -h, --help              Help
  -v, --version           Version

Model providers, default models and credentials come from DeepSeek Harness's own
configuration: the selected profile's cordis.patch.yml, the home cordis.patch.yml
and $DSH_HOME/.credentials.yaml. DSH TUI never reads Pi models.json/auth.json.
Use --profile <name> (for example the profile you configured models in) instead of
copying provider catalogs. Without --profile, DSH's default base composition plus
home-level native configuration is used.

Type /help inside the TUI. This checkout can be linked locally as dsh-tui.
`

const MODELS_FILE_HELP = `dsh-tui: --models-file was removed and no fallback is attempted.

DSH TUI uses DeepSeek Harness native configuration only:
  - configure providers, model defaults and credentials in DSH (a profile's
    cordis.patch.yml, the home cordis.patch.yml, or the DSH settings UI);
  - then select that profile with: dsh-tui --profile <name> [--model provider/model].

Pi models.json/auth.json is never imported. Run dsh-tui --help for the current options.
`

export async function main(args: string[]): Promise<void> {
  if (args.some(argument => argument === '--models-file' || argument.startsWith('--models-file='))) {
    process.stderr.write(MODELS_FILE_HELP)
    process.exitCode = 2
    return
  }
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      demo: { type: 'boolean' }, inline: { type: 'boolean' }, fullscreen: { type: 'boolean' },
      cwd: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' }, profile: { type: 'string' },
      dsh: { type: 'string' }, 'dsh-home': { type: 'string' },
      resume: { type: 'string', short: 'r' }, continue: { type: 'boolean', short: 'c' },
      'config-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    } })
  } catch (error) { process.stderr.write(String(error instanceof Error ? error.message : error) + '\nUse --help.\n'); process.exitCode = 2; return }
  const values = parsed.values
  if (values.help) { process.stdout.write(HELP); return }
  if (values.version) { process.stdout.write('0.1.0\n'); return }
  if (values.inline && values.fullscreen) { process.stderr.write('Choose --inline or --fullscreen, not both.\n'); process.exitCode = 2; return }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stderr.write('dsh-tui requires an interactive terminal. Use --help for usage.\n'); process.exitCode = 2; return }
  const string = (key: string) => typeof values[key] === 'string' ? values[key] as string : undefined
  const cwd = resolve(string('cwd') ?? process.cwd())
  let model = string('model')
  let provider = string('provider')
  if (model?.includes('/')) { const split = model.indexOf('/'); provider = model.slice(0, split); model = model.slice(split + 1) }
  let app: App | undefined
  try {
    const { App } = await import('./app.ts')
    const backend = values.demo
      ? new (await import('./demo.ts')).DemoBackend({ cwd })
      : new (await import('./backend/index.ts')).DshBackend({ cwd, dshPath: string('dsh'), home: string('dsh-home'), resume: string('resume'), provider, model, profile: string('profile') })
    app = new App({ backend, cwd, demo: Boolean(values.demo), screen: values.fullscreen ? 'fullscreen' : values.inline ? 'inline' : undefined, configDir: string('config-dir'), initialPrompt: parsed.positionals.join(' ') || (values.demo ? 'tools' : undefined), continueLatest: Boolean(values.continue) })
    await app.start()
    process.exitCode = await app.exited
  } catch (error) {
    if (app) await app.shutdown(1).catch(() => {})
    process.stderr.write('dsh-tui: ' + String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
