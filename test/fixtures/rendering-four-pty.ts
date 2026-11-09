/** Explicit offline rendering fixture for real terminal/hover acceptance. */
import { mkdir, writeFile } from 'node:fs/promises'
import { App } from '../../src/app.ts'
import { RenderingFixture } from '../helpers/rendering-fixture.ts'

const cwd = process.argv[2], configDir = process.argv[3]
const screen = process.argv[5] === 'inline' ? 'inline' : 'fullscreen'
if (!cwd || !configDir) throw new Error('Owned temporary paths required')
await mkdir(configDir, { recursive: true })
await writeFile(configDir + '/settings.json', JSON.stringify({ showThinking: true, thinkingPreviewLines: 3,
  groupTools: true, groupSubagentMessages: true }))
const app = new App({ backend: new RenderingFixture(cwd), cwd, configDir, screen, demo: true })
await app.start()
await app.exited
