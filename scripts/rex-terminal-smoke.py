#!/usr/bin/env python3
"""Actual Rex, owned fixtures only: program status, title/cwd, decisions and cleanup.

Public rex CLI only. The built offline demo has zero model/network calls. No
existing pane is captured or changed; no shell startup file or user profile is
loaded. This checks server protocol events/records, not OS notification grants.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote

PROJECT = Path(__file__).resolve().parent.parent
OUT = PROJECT / '.cache/rex-static-title/rex-live'
REX = shutil.which('rex')
NODE = shutil.which('node')
assert REX and NODE, 'installed rex and node are required'
ORIGINAL_TITLE = 'Rex fixture original shell'
OUT.mkdir(parents=True, exist_ok=True)


def cli(*args, json_result=True):
    output = subprocess.run([REX, '--timeout', '5s', *args], capture_output=True, text=True, timeout=8)
    assert output.returncode == 0, (args[:2], output.stderr)
    return json.loads(output.stdout) if json_result else output.stdout


def run(mode):
    with tempfile.TemporaryDirectory(prefix='fixture-', dir=OUT) as directory:
        base = Path(directory)
        home, workspace, config = base / 'home', base / 'workspace', base / 'config'
        for path in [home, workspace, config]:
            path.mkdir()
        (config / 'settings.json').write_text(json.dumps({'formatVersion': 2, 'copyOnSelect': False}), encoding='utf8')
        wrapper = base / 'wrapper.py'
        wrapper.write_text("""import os,sys
assert os.environ['HOME'] == sys.argv[1]
os.write(1,b'\\x1b]0;Rex fixture original shell\\x07')
os.execv(sys.argv[2],[sys.argv[2],*sys.argv[3:]])
""", encoding='utf8')
        created = cli('new', 'dsh-terminal-acceptance', '--shell=none', '--keep-open', '-c', str(workspace), '--json', '--',
                      '/usr/bin/env', '-i', 'HOME=' + str(home), 'USERPROFILE=' + str(home),
                      'DSH_HOME=' + str(home / '.dsh'), 'XDG_CONFIG_HOME=' + str(home / '.config'),
                      'PATH=/opt/homebrew/bin:/usr/bin:/bin', 'TERM=xterm-rex', 'TERM_PROGRAM=rex',
                      'COLORTERM=truecolor', 'COLUMNS=100', 'LINES=35',
                      sys.executable, str(wrapper), str(home), NODE, str(PROJECT / 'bin/dsh-tui.mjs'),
                      '--demo', '--' + mode, '--config-dir', str(config), ' ')
        session = created['session_id']
        block = created['initial_windows'][0]['block_ids'][0]
        events = []
        watcher = subprocess.Popen([REX, 'events', '-s', session, '--json'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def collect():
            assert watcher.stdout
            for line in watcher.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                text = json.dumps(event)
                if any(name in text for name in ['program_status', 'title_changed', 'pwd_changed', 'desktop_notification', 'progress_report', 'child_exited']):
                    events.append(event)
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()

        def call(method):
            return cli('block', 'call', '-s', session, '-b', block, method)

        def root_status():
            records = call('program_status')['records']
            return next((record for record in records if not record.get('id')), None)

        def wait_state(state, kind=None, timeout=12):
            deadline = time.monotonic() + timeout
            last = None
            while time.monotonic() < deadline:
                last = root_status()
                if last and last.get('state') == state and (kind is None or last.get('kind') == kind):
                    return last
                process = call('process')
                assert process.get('last_exit') is None, ('unexpected exit', process, last)
                time.sleep(0.12)
            capture = cli('capture', '-s', session, '-b', block, '--trim', json_result=False)
            raise AssertionError(('missing state', state, kind, last, capture[-2500:]))

        def send(text):
            cli('send', '-s', session, '-b', block, text, json_result=False)
            cli('send-key', '-s', session, '-b', block, 'enter', json_result=False)

        def key(name):
            cli('send-key', '-s', session, '-b', block, name, json_result=False)

        try:
            first = wait_state('idle')
            assert first['app'] == 'terminal'
            title = call('title')['title']
            assert title == '🐳 dsh-tui · workspace', title
            pwd = call('pwd')['pwd']
            assert pwd.startswith('file://') and pwd.endswith(quote(str(workspace))), pwd
            phases = [{'state': 'idle', 'app': first['app']}]
            send('streaming fixture')
            phases.append({'state': wait_state('working')['state']})
            assert call('title')['title'] == title, 'working state must not decorate the title'
            phases.append({'state': wait_state('done')['state']})
            send('approval')
            approval = wait_state('blocked', 'permission')
            assert approval['msg'] == 'Waiting for approval'
            phases.append({'state': approval['state'], 'kind': approval['kind']})
            key('ctrl+c')
            phases.append({'state': wait_state('idle')['state'], 'cancelled': True})
            send('question')
            question = wait_state('blocked', 'question')
            assert question['msg'] == 'Waiting for your answer'
            phases.append({'state': question['state'], 'kind': question['kind']})
            key('ctrl+c')
            wait_state('idle')
            send('error')
            failure = wait_state('error')
            assert failure['msg'] == 'Turn failed'
            phases.append({'state': failure['state']})
            send('subagent')
            wait_state('done')
            records = call('program_status')['records']
            children = [record for record in records if record.get('id')]
            assert any(record.get('state') == 'working' and record.get('title') == 'Explore repository' for record in children), children
            assert len(records) <= 64
            assert all(record.get('app') == 'terminal' for record in children)
            phases.append({'state': 'done', 'independentChildWorking': True})
            key('ctrl+c'); key('ctrl+c')
            deadline = time.monotonic() + 8
            exit_state = None
            while time.monotonic() < deadline:
                exit_state = call('process').get('last_exit')
                if exit_state is not None:
                    break
                time.sleep(0.12)
            assert exit_state and exit_state['exit_code'] == 0, exit_state
            assert call('program_status')['records'] == []
            restored_title = call('title')['title']
            # This installed Rex version ignores CSI 22/23 and CSI 21 (verified
            # separately). Do not turn that terminal limitation into a false
            # claim of application-level custom-title restoration.
            assert restored_title in [ORIGINAL_TITLE, title], restored_title
            title_stack_restored = restored_title == ORIGINAL_TITLE
            modes = call('modes')
            assert modes['screen'] == 'primary'
            active = {row['number'] for row in modes['modes'] if row.get('set') and not row.get('ansi')}
            for number in [1000, 1002, 1003, 1004, 1006, 1049, 2004, 2026]:
                assert number not in active, ('mode not restored', number, active)
            # Program Activity is terminal-owned; the app never adds an OSC 777
            # notification on top in automatic Rex mode.
            direct_notifications = [event for event in events if 'desktop_notification' in json.dumps(event)]
            assert not direct_notifications, direct_notifications
            titles = []
            for event in events:
                block_event = event.get('payload', {}).get('event', {}).get('payload', {})
                if block_event.get('name') == 'title_changed':
                    titles.append(block_event.get('payload', {}).get('title', ''))
            app_titles = [value for value in titles if value != ORIGINAL_TITLE]
            assert all(value == title for value in app_titles), ('unexpected title decoration', app_titles)
            result = {'mode': mode, 'exit': 0, 'modelCalls': 0, 'protocolStatus': True,
                      'nativeDecisionKinds': True, 'nativeChildRecords': True, 'titleAndWorkspace': True,
                      'titleWhale': '🐳', 'staticWhaleTitle': True,
                      'titleStackRestored': title_stack_restored,
                      'titleRestoreLimit': None if title_stack_restored else 'terminal ignores title stack/query; shell owns final title reset',
                      'noDuplicateExplicitNotifications': True, 'terminalRestored': True,
                      'privateHomeAndWorkspace': True, 'phases': phases}
            (OUT / (mode + '-result.json')).write_text(json.dumps(result, indent=2), encoding='utf8')
            return result
        finally:
            (OUT / (mode + '-events.jsonl')).write_text(''.join(json.dumps(event) + '\n' for event in events), encoding='utf8')
            if watcher.poll() is None:
                watcher.terminate()
                try:
                    watcher.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    watcher.kill(); watcher.wait()
            reader.join(timeout=1)
            cli('kill', session, json_result=False)


if __name__ == '__main__':
    modes = sys.argv[1:] or ['inline', 'fullscreen']
    assert all(mode in ['inline', 'fullscreen'] for mode in modes)
    print(json.dumps({'rexTerminalAcceptance': [run(mode) for mode in modes]}, indent=2))
