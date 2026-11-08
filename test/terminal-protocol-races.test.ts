import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const project = fileURLToPath(new URL('../', import.meta.url))
const reply = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

/** The real ProcessTerminal input pipeline in a private child, never this harness's TTY. */
function probe(body: string): { result: Record<string, unknown>; stdout: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-terminal-protocol-race-'))
  const resultPath = join(home, 'result.json')
  mkdirSync(join(home, '.config'))
  try {
    const source = `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      import { ProcessTerminal } from '#pi-tui';
      const writes=[], input=[], focus=[];
      const terminal = new ProcessTerminal({write:data=>writes.push(data)});
      const emit=data=>process.stdin.emit('data',data);
      const reply=${JSON.stringify(reply)};
      const reportCount=()=>writes.filter(data=>data.includes(']7501;state=')).length;
      terminal.start(data=>input.push(data),()=>{});
      ${body}
      writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));
      terminal.stop();
    `
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: project, env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), DSH_HOME: join(home, '.dsh'),
        TERM: 'xterm-256color', TERM_PROGRAM: 'fixture', PATH: '/usr/bin:/bin:/opt/homebrew/bin' },
      encoding: 'utf8', timeout: 8_000, maxBuffer: 1024 * 1024,
    })
    assert.equal(output.error, undefined)
    assert.equal(output.status, 0, output.stderr)
    const result: unknown = JSON.parse(readFileSync(resultPath, 'utf8'))
    assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result))
    return { result: result as Record<string, unknown>, stdout: output.stdout }
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('a support reply arriving after the DA sentinel cannot revive an unsupported or retired query', () => {
  const { result } = probe(String.raw`
    terminal.setProgramStatus({state:'working',app:'dsh-tui'});
    emit('\x1b[?1;2c');
    emit(reply);
    await delay(20);
    const result={supported:terminal.programStatusSupported,reports:reportCount(),input};
  `)
  assert.equal(result.supported, false)
  assert.equal(result.reports, 0)
  assert.deepEqual(result.input, [], 'terminal control replies are never typed into the editor')
})

test('stop relinquishes writes before support callbacks can restart a legacy progress heartbeat', () => {
  const { result } = probe(String.raw`
    terminal.setProgramStatus({state:'working',app:'dsh-tui'});
    emit(reply);
    terminal.onProgramStatusSupportChange(supported=>{if(!supported)terminal.setProgress(true)});
    terminal.stop();
    const atStop=writes.length;
    await delay(1150);
    terminal.setProgress(true);
    terminal.setProgramStatus({state:'working',app:'dsh-tui'});
    terminal.setProgramStatus({state:'clear'});
    terminal.setTitle('late title');
    terminal.setFocusReporting(true);
    terminal.saveTitle(); terminal.restoreTitle();
    const result={lateWrites:writes.length-atStop};
  `)
  assert.equal(result.lateWrites, 0)
})

test('the emergency exit handoff also refuses a late root clear through the normal writer', () => {
  const { result, stdout } = probe(String.raw`
    emit(reply);
    terminal.setProgramStatus({state:'working',app:'dsh-tui'});
    terminal.setFocusReporting(true);
    terminal.saveTitle();
    terminal.restoreOnExit('','');
    const afterRestore=writes.length;
    terminal.setProgramStatus({state:'clear'});
    terminal.setProgress(true);
    terminal.setTitle('late title');
    const result={lateWrites:writes.length-afterRestore};
  `)
  assert.equal(result.lateWrites, 0)
  assert.match(stdout, /\x1b\]7501;state=clear/)
  assert.match(stdout, /\x1b\[\?1004l/)
  assert.match(stdout, /\x1b\[23;0t/)
})

test('a fragmented focus header stays a terminal report rather than Alt-[ followed by an editor letter', () => {
  const { result } = probe(String.raw`
    emit('\x1b[?1;2c');
    terminal.onFocusChange(value=>focus.push(value));
    terminal.setFocusReporting(true);
    emit('\x1b[I');
    emit('\x1b[');
    await delay(80);
    emit('O');
    await delay(30);
    const result={focus,input,focused:terminal.terminalFocused};
  `)
  assert.deepEqual(result.focus, [true, false])
  assert.deepEqual(result.input, [])
  assert.equal(result.focused, false)
})

test('several oversized reply chunks stay quarantined through their actual terminator', () => {
  const { result } = probe(String.raw`
    emit('\x1b[?1;2c');
    emit('\x1b]11;'+'x'.repeat(20000));
    emit('y'.repeat(20000));
    emit('untrusted\r\x07SAFE');
    await delay(20);
    const result={input:input.join('')};
  `)
  assert.equal(result.input, 'SAFE', 'the oversized tail cannot become text or an Enter action')
})

test('a complete oversized terminal response also respects the byte cap before dispatch', () => {
  const { result } = probe(String.raw`
    emit('\x1b[?1;2c');
    emit('\x1b]11;'+'y'.repeat(20000)+'\x07SAFE');
    await delay(20);
    const result={input:input.join('')};
  `)
  assert.equal(result.input, 'SAFE')
})
