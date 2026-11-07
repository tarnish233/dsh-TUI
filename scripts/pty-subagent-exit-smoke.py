#!/usr/bin/env python3
"""Actual native DSH exit with live children; hermetic streams and private PTYs."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('native_exit_helpers', Path(__file__).with_name('pty-native-plugin.py'))
assert spec and spec.loader
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
helper = native.helper


def frame(session):
    # Only private PTY output is decoded, never real clipboard/user terminal data.
    for _ in range(4):
        session.read(0.02)
    result = subprocess.run([helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'), '110', '32'],
                            input=bytes(session.raw), capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)


def wait_frame(session, predicate, label, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = frame(session)
        if predicate(last):
            return last
        assert not session.poll_exit(), 'native process exited before ' + label
    raise AssertionError(label + ' timed out:\n' + '\n'.join(last['lines']))


def finish_exit(session, offset, expected, timeout=12):
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        session.read(0.05)
        if session.poll_exit():
            result = session.finish(code=expected, restore_offset=offset)
            result['shutdownSeconds'] = round(time.monotonic() - started, 3)
            return result
    restored = b'\x1b[?2004l' in bytes(session.raw[offset:])
    raise AssertionError('native exit did not finish within %.1fs; terminalRestored=%s; active child still owns the native runtime' % (timeout, restored))


def run(request, mode, action):
    session = native.NativeSession(request, mode, 'live-child-' + action)
    helper.OUT = Path(request['artifactsDir'])
    helper.OUT.mkdir(parents=True, exist_ok=True)
    try:
        session.wait_for(b'ready', timeout=20)
        session.send(b'fixture:subagent-stop\r')
        screen = wait_frame(session, lambda value: any('Child stoppable' in line and 'running' in line for line in value['lines'])
                            and any(' · ready' in line for line in value['lines']),
                            'genuinely idle root with a live native child')
        assert any('● Agents' in line for line in screen['lines']), 'real active child is projected above the Editor'
        offset = len(session.raw)
        if action == 'ctrl-c':
            session.send(b'\x03')
            wait_frame(session, lambda value: any('Press the same exit key again to exit' in line for line in value['lines']),
                       'empty-root exit confirmation', timeout=2)
            session.send(b'\x03')
            expected = 0
        elif action == 'slash-exit':
            session.send(b'/exit\r')
            expected = 0
        elif action == 'sigint':
            os.kill(session.pid, signal.SIGINT)
            expected = 130
        else:
            raise AssertionError('unknown exit scenario')
        result = finish_exit(session, offset, expected)
        assert 'native child should have been interrupted' not in bytes(session.raw[offset:]).decode('utf8', 'replace'), 'child must not run its full delayed response during exit'
        result.update({'nativeProfile': True, 'rootIdle': True, 'liveChildAtExit': True,
                       'action': action, 'hermeticStream': True})
        return result
    finally:
        # Coverage includes failure: a timed-out native disposer cannot leak a
        # live test process. SIGKILL targets this fixture's own private PID only.
        session.close()


if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    modes = request.get('modes', ['inline', 'fullscreen'])
    actions = request.get('actions', ['ctrl-c', 'slash-exit', 'sigint'])
    print(json.dumps({'nativeSubagentExitPty': [run(request, mode, action) for mode in modes for action in actions]}, indent=2))
