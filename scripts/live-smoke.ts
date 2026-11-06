/** Manual opt-in only: the native DSH launcher owns the complete TUI/model session. */
import { main } from '../src/cli.ts'

if (process.env.DSH_TUI_LIVE !== '1') {
  process.stdout.write('Manual only: DSH_TUI_LIVE=1 node scripts/live-smoke.ts. This sends one small prompt through the installed native dsh-tui profile.\n')
} else {
  const args = ['--profile', process.env.DSH_TUI_LIVE_PROFILE ?? 'dsh-tui']
  const model = process.env.DSH_TUI_LIVE_MODEL
  const provider = process.env.DSH_TUI_LIVE_PROVIDER
  if (model !== undefined) args.push('--model', provider === undefined || model.includes('/') ? model : `${provider}/${model}`)
  args.push('只回复 dsh-tui-ok，不要调用任何工具。')
  await main(args)
}
