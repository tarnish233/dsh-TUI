#!/usr/bin/env python3
"""Native DSH owns exit deadlines even when local App cleanup is deliberately held.

Only caller-created private profiles/workspaces are used; no model prompts,
credentials, real user configuration, global packages or private exit controller.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import struct
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('private_pty_session', Path(__file__).with_name('pty-cancel-smoke.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class NativeHeldSession(helper.Session):
    def __init__(self, request):
        self.mode = request['screen']
        self.scenario = 'native-exit-held-' + request['held']
        self.config = tempfile.mkdtemp(prefix='private-ui-', dir=request['directory'])
        self.raw = bytearray()
        self.status = None
        self.started = time.monotonic()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(request['cwd'])
            argv = [helper.NODE, request['bin'], '--profile', 'dsh-tui',
                    '--config-dir', self.config, '--' + self.mode]
            os.execve(helper.NODE, argv, request['env'])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))


def run(request):
    helper.OUT = Path(request['out'])
    helper.OUT.mkdir(parents=True, exist_ok=True)
    session = NativeHeldSession(request)
    try:
        session.wait_for(b'ready', timeout=20)
        assert b'Working' not in session.raw, 'this test sends no model prompt'
        offset = len(session.raw)
        start = time.monotonic()
        session.send(b'/exit\r')
        session.wait_for(b'\x1b[?2004l', offset, timeout=1.5)
        restoration = time.monotonic() - start
        deadline = start + 7.0
        while not session.poll_exit():
            session.read(0.02)
            assert time.monotonic() < deadline, ('native exit was not requested before held cleanup', session.tail())
        for _ in range(6):
            session.read(0.01)
        elapsed = time.monotonic() - start
        actual = os.waitstatus_to_exitcode(session.status)
        assert actual == 0, ('first explicit /exit code belongs to native DSH', actual, session.tail())
        assert Path(request['heldMarker']).is_file(), 'the controlled cleanup hold was actually entered'
        assert 4.5 <= elapsed < 7.0, ('native 5000ms controller should end the held tree', elapsed)
        assert restoration < 1.5, ('terminal must be handed back before the native grace period', restoration)
        session.assert_restored(offset)
        assert b'Could not start DSH' not in session.raw, session.tail()
        return {'screen': request['screen'], 'held': request['held'], 'exit': actual,
                'nativeDeadlineSeconds': round(elapsed, 3),
                'terminalRestoreSeconds': round(restoration, 3),
                'terminalRestored': True, 'controlledHoldEntered': True,
                'nativeLauncherOwnedExit': True, 'providerCalls': False}
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps(run(json.loads(sys.argv[1])), indent=2))
