import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeProfileFixture, type NativeProfileFixture } from './native-profile.ts'
import type { App } from '../../src/app.ts'
import type { DshContextBackend, DshHostContext } from '../../src/backend/context.ts'
import type { BackendEvent, JsonRecord, SessionEvent } from '../../src/backend/types.ts'
import type { VirtualTerminal } from './terminal.ts'
import type { strict as strictAssert } from 'node:assert'

export interface NativeScene {
  app: App
  backend: DshContextBackend
  terminal: VirtualTerminal
  events: BackendEvent[]
  ctx: DshHostContext
  cwd: string
  home: string
  directory: string
  assert: typeof strictAssert
  until(condition: () => boolean, label: string, timeout?: number): Promise<void>
  delay(ms: number): Promise<void>
  object(value: unknown): JsonRecord
  facts(events?: BackendEvent[]): SessionEvent[]
  userText(event: SessionEvent): string
  paint(): Promise<void>
}

/** Execute assertions in the *same* real DSH process as the App/adapter, not across an IPC backend. */
export async function runNativeScene(
  scenario: (scene: NativeScene, params: JsonRecord) => Promise<void>,
  params: JsonRecord = {},
  options: {
    screen?: 'inline' | 'fullscreen'
    extraPatch?: readonly JsonRecord[]
    /** Public native services required by this synthetic scenario, never a bypass of Cordis injection. */
    extraInject?: readonly string[]
    streamFixture?: string
    timeout?: number
    /** Prepare synthetic files in the isolated fixture before native services or catalog caches start. */
    prepare?: (fixture: NativeProfileFixture) => Promise<void>
  } = {},
): Promise<void> {
  const fixture = await nativeProfileFixture()
  const resultPath = join(fixture.directory, 'result.json')
  const scenarioPath = join(fixture.cwd, 'scenario.mjs')
  const runnerPath = join(fixture.cwd, 'runner.mjs')
  const mock = options.streamFixture ?? new URL('../fixtures/mock-stream.mjs', import.meta.url).href
  const library = (path: string) => new URL('../../lib/' + path, import.meta.url).href
  const terminalModule = new URL('./terminal.ts', import.meta.url).href
  try {
    await options.prepare?.(fixture)
    await writeFile(scenarioPath, `export const run = ${scenario.toString()};\n`)
    await writeFile(runnerPath, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { App } from ${JSON.stringify(library('app.js'))};
import { createDshBackend } from ${JSON.stringify(library('backend/context.js'))};
import { mountNativePresets } from ${JSON.stringify(library('plugin/presets.js'))};
import { installCompactionReasoningEffort } from ${JSON.stringify(library('plugin/compaction.js'))};
import { VirtualTerminal, until, delay } from ${JSON.stringify(terminalModule)};
import { run } from ${JSON.stringify(pathToFileURL(scenarioPath).href)};
export const name = 'parent-native-scene';
export const inject = ${JSON.stringify(['agents', 'llm', 'sessions', 'sessionPersistence', 'agentPresets', ...(options.extraInject ?? [])])};
export function apply(ctx) {
 let app, terminal;
 ctx.effect(() => async () => {app?.restoreTerminal(); await app?.shutdown(); terminal?.dispose()}, 'native-scene.cleanup');
 ctx.effect(() => ctx.appReady.onReady(() => { void (async () => {
  installCompactionReasoningEffort(ctx,{warn:message=>ctx.logger.warn(message)});
  await mountNativePresets(ctx);
  const events=[];
  const backend=createDshBackend(ctx,{cwd:${JSON.stringify(fixture.cwd)},provider:'deepseek-official',model:'deepseek-v4-flash'});
  backend.onEvent(event=>events.push(event));
  terminal=new VirtualTerminal(110,35);
  app=new App({backend,cwd:${JSON.stringify(fixture.cwd)},configDir:${JSON.stringify(join(fixture.directory, 'tui'))},terminal,screen:${JSON.stringify(options.screen ?? 'fullscreen')},registerSignals:false});
  await app.start();
  const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const facts=(source=events)=>source.flatMap(event=>event.type==='session_event'?[event.event]:[]);
  const userText=event=>(object(event.data).content??[]).filter(block=>block.type==='text').map(block=>block.text).join('');
  await run({app,backend,terminal,events,ctx,cwd:${JSON.stringify(fixture.cwd)},home:${JSON.stringify(fixture.home)},directory:${JSON.stringify(fixture.directory)},assert,until,delay,object,facts,userText,paint:async()=>{await delay(60);await terminal.flush()}},${JSON.stringify(params)});
  await app.shutdown();
  writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:true}));
  ctx.appExit(0);
 })().catch(async error=>{
  app?.restoreTerminal(); await app?.shutdown(1).catch(()=>{});
  writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:String(error?.stack??error)}));
  ctx.appExit(1);
 })}), 'native-scene.ready');
}
`)
    const patch: JsonRecord[] = [
      { id: 'dsh-tui-startup', disabled: true },
      { id: 'dsh-tui', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'llm-deepseek', config: {
        baseURL: 'http://127.0.0.1:9/anthropic', apiKeyEnv: 'DSH_NATIVE_TEST_KEY',
        models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
      } },
      ...(options.extraPatch ?? []),
      { insert: [{ id: 'native-offline-stream', name: mock }, { id: 'native-parent-scene', name: pathToFileURL(runnerPath).href }] },
    ]
    await writeFile(join(fixture.profileDir, 'cordis.patch.yml'), JSON.stringify(patch))
    const output = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, fixture.args(), {
        cwd: fixture.cwd,
        env: { ...fixture.env, DSH_NATIVE_TEST_KEY: 'synthetic-native-test-key' },
        timeout: options.timeout ?? 30_000, maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : 1, stdout, stderr }))
    })
    let result: { ok?: boolean; error?: string } = {}
    try { result = JSON.parse(await readFile(resultPath, 'utf8')) as typeof result } catch { /* native failure before scene activation */ }
    if (output.code !== 0 || result.ok !== true) throw new Error(result.error ?? ('Native scene did not complete:\n' + output.stdout + output.stderr).slice(-10000))
  } finally { await fixture.cleanup() }
}
