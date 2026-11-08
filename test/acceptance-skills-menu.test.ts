import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { JsonRecord } from '../src/backend/types.ts'
import { runNativeScene, type NativeScene } from './helpers/native-scenario.ts'
import type { NativeProfileFixture } from './helpers/native-profile.ts'

const streamFixture = new URL('./fixtures/skills-stream.mjs', import.meta.url).href

async function prepareSkills(fixture: NativeProfileFixture): Promise<void> {
  // Both spellings stay inside the isolated HOME/DSH_HOME. No real user skill
  // is read: this fixture exists before native services/caches start.
  for (const root of [join(fixture.home, 'skills'), join(fixture.home, '.dsh', 'skills')]) {
    const directory = join(root, 'skill-studio')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: skill-studio\ndescription: Native user-home metadata fixture.\n---\nSYNTHETIC_USER_HOME_BODY\n')
  }
  const project = join(fixture.cwd, '.agents', 'skills', 'project-probe')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'SKILL.md'), '---\nname: project-probe\ndescription: Native project metadata control.\n---\nSYNTHETIC_PROJECT_BODY\n')
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native user-home Skills appear after an ordinary first message without Help or a forced query (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const fixture = await import(String(params.streamFixture))
      const requests = fixture.observations as Array<{ texts: string[] }>
      await scene.app.submit('ordinary first message; no skill gesture')
      await scene.until(() => requests.length > 0 && !scene.app.isBusy, 'ordinary native response', 10_000)
      scene.assert.ok(requests[0]!.texts.some(text => text.includes('<available_skills>') && text.includes('skill-studio')), 'native model discovery includes the user-home skill')
      scene.terminal.type('/skill-stu')
      await scene.paint(); await scene.delay(150); await scene.paint()
      scene.assert.ok(scene.app.editor.isShowingAutocomplete(), 'a normal prefix opens the actual skill menu, without /help or backend.command(skills) warming it')
      scene.assert.match(scene.terminal.screen(), /skill-studio.*Skill/)
      scene.assert.equal(scene.app.editor.getText(), '/skill-stu')
      scene.assert.equal(requests.length, 1, 'listing metadata never sends another model prompt')
    }, { streamFixture }, { screen, streamFixture, timeout: 30_000, prepare: prepareSkills })
  })

  test(`one Enter on /skill-stu submits the completed name and native instructions (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const fixture = await import(String(params.streamFixture))
      const requests = fixture.observations as Array<{ texts: string[] }>
      scene.terminal.type('/skill-stu')
      await scene.paint(); await scene.delay(120); await scene.paint()
      scene.assert.ok(scene.app.editor.isShowingAutocomplete(), 'native candidate is selected before Enter')
      scene.terminal.type('\r')
      await scene.until(() => requests.length === 1 && !scene.app.isBusy, 'native direct Enter response')
      scene.assert.ok(requests[0]!.texts.includes('/skill-studio'), 'the content-aware submit carries the completed name, not /skill-stu')
      scene.assert.ok(requests[0]!.texts.some(text => text.includes('<skill_content name="skill-studio">') && text.includes('SYNTHETIC_USER_HOME_BODY')))
      scene.assert.equal(scene.app.editor.getText(), '')
      scene.assert.equal(scene.app.editor.isShowingAutocomplete(), false)
      scene.assert.ok(scene.facts().some(event => event.type === 'user/message' && scene.userText(event) === '/skill-studio'))
    }, { streamFixture }, { screen, streamFixture, timeout: 30_000, prepare: prepareSkills })
  })

  test(`one Enter executes the selected native command without sending its prefix to the model (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const fixture = await import(String(params.streamFixture))
      const requests = fixture.observations as Array<{ texts: string[] }>
      await scene.app.submit('ordinary native command-completion setup')
      await scene.until(() => requests.length === 1 && !scene.app.isBusy, 'native setup response')
      scene.terminal.type('/pl')
      await scene.paint(); await scene.delay(100); await scene.paint()
      scene.assert.ok(scene.app.editor.isShowingAutocomplete(), 'native /plan candidate is selected')
      scene.terminal.type('\r')
      await scene.until(() => scene.facts().some(event => event.type === 'command/run' && scene.object(event.data).name === 'plan'), 'selected /plan native execution')
      await scene.paint()
      scene.assert.equal(requests.length, 1, 'Enter never sends /pl or /plan as a model prompt')
      scene.assert.equal(scene.facts().some(event => event.type === 'user/message' && scene.userText(event) === '/pl'), false)
      scene.assert.equal(scene.app.editor.getText(), '')
    }, { streamFixture }, { screen, streamFixture, timeout: 30_000, prepare: prepareSkills })
  })

  test(`native preset scope exposes user-home Skills before any message or Agent exists (${screen})`, async () => {
    await runNativeScene(async (scene: NativeScene, params: JsonRecord) => {
      const fixture = await import(String(params.streamFixture))
      const requests = fixture.observations as Array<{ texts: string[] }>
      const sessionId = scene.app.session?.sessionId
      const agents = scene.object(scene.ctx.get('agents'))
      scene.assert.equal(typeof agents.get, 'function')
      const get = agents.get as (id: string) => unknown
      scene.assert.equal(get.call(agents, String(sessionId)), undefined, 'blank startup has not created an Agent')
      scene.terminal.type('/skill-stu')
      await scene.paint(); await scene.delay(150); await scene.paint()
      scene.assert.ok(scene.app.editor.isShowingAutocomplete(), 'native cold preset metadata is available in the first / menu')
      scene.assert.match(scene.terminal.screen(), /skill-studio.*Skill/)
      scene.assert.equal(scene.app.editor.getText(), '/skill-stu')
      scene.assert.equal(get.call(agents, String(sessionId)), undefined, 'menu lookup still creates no Agent')
      scene.assert.equal(requests.length, 0, 'menu lookup calls no model')
      scene.assert.equal(scene.facts().length, 0, 'menu lookup creates no durable session facts')
      scene.assert.doesNotMatch(scene.terminal.screen(), /SYNTHETIC_USER_HOME_BODY/)
    }, { streamFixture }, { screen, streamFixture, timeout: 30_000, prepare: prepareSkills })
  })
}
