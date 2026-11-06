#!/usr/bin/env python3
"""Native DSH profile/terminal lifecycle. Private PTY; no model prompts or clipboard."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import signal
import struct
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pty_session', Path(__file__).with_name('pty-cancel-smoke.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class NativeSession(helper.Session):
    def __init__(self, request, mode, scenario, demo=False):
        self.mode = mode
        self.scenario = 'native-' + scenario
        self.implicit_fullscreen = mode == 'fullscreen' and request.get('implicitFullscreen', False)
        self.config = tempfile.mkdtemp(prefix='dsh-native-pty-ui-')
        self.raw = bytearray()
        self.status = None
        self.started = time.monotonic()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(request['cwd'])
            argv = [helper.NODE, request['bin'], '--profile', 'dsh-tui',
                    '--config-dir', self.config]
            if not self.implicit_fullscreen:
                argv += ['--' + mode]
            if demo:
                argv += ['--demo', ' ']
            os.execve(helper.NODE, argv, request['env'])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))


def run(request, mode, demo=False, interrupt=False):
    session = NativeSession(request, mode, 'sigint' if interrupt else 'lifecycle', demo)
    try:
        session.wait_for(b'ready', timeout=20)
        if session.implicit_fullscreen:
            assert b'\x1b[?1049h' in session.raw, 'no screen flag must enter the alternate screen'
        draft = b'native plugin retained draft'
        session.send(draft)
        session.wait_for(draft)
        opened = len(session.raw)
        session.send(b'\x1bOP')
        session.wait_for(b'Help', opened)
        closed = len(session.raw)
        session.send(b'\x1b')
        session.wait_for(draft, closed)
        resized = len(session.raw)
        fcntl.ioctl(session.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
        os.kill(session.pid, signal.SIGWINCH)
        session.wait_for(draft, resized)
        if interrupt:
            offset = len(session.raw)
            os.kill(session.pid, signal.SIGINT)
            result = session.finish(code=130, restore_offset=offset)
        else:
            paused = len(session.raw)
            session.send(b'\x1a')
            session.wait_for(b'\x1b[?2004l', paused)
            # Restore bytes can reach the parent before the child has installed
            # its SIGCONT listener and delivered SIGTSTP. Let that local signal
            # boundary settle; sending CONT before STOP would strand the child.
            deadline = time.monotonic() + 0.15
            while time.monotonic() < deadline:
                session.read(0.01)
            continued = len(session.raw)
            os.kill(session.pid, signal.SIGCONT)
            session.wait_for(draft, continued)
            session.wait_for(b'\x1b[?2004h', continued)
            offset = len(session.raw)
            session.send(b'\x15/exit\r')
            result = session.finish(restore_offset=offset)
            result['suspendResume'] = True
        assert b'Could not start DSH' not in session.raw, session.tail()
        assert b'Working' not in session.raw, 'lifecycle must send no model prompt'
        result.update({'nativeProfile': True, 'demo': demo, 'draftPreserved': True,
                       'helpAndResize': True, 'implicitFullscreen': session.implicit_fullscreen,
                       'pixelRenderingTested': False})
        return result
    finally:
        session.close()


def remount(request, mode):
    session = NativeSession(request, mode, 'unmount-remount', True)
    patch = Path(request['profileDir']) / 'cordis.patch.yml'
    try:
        session.wait_for(b'ready', timeout=20)
        for index in range(2):
            off = len(session.raw)
            patch.write_text(json.dumps([{'id': 'dsh-tui', 'disabled': True}]))
            session.wait_for(b'\x1b[?2004l', off, timeout=12)
            assert not session.poll_exit(), 'unloading just the frontend must not exit DSH'
            on = len(session.raw)
            patch.write_text('[]\n')
            session.wait_for(b'\x1b[?2004h', on, timeout=12)
            session.wait_for(b'ready', on, timeout=12)
        draft = b'one remounted editor'
        session.send(draft)
        session.wait_for(draft)
        offset = len(session.raw)
        session.send(b'\x15/exit\r')
        result = session.finish(restore_offset=offset)
        result.update({'nativeProfile': True, 'unmountRemountCycles': 2,
                       'implicitFullscreen': session.implicit_fullscreen,
                       'pixelRenderingTested': False})
        return result
    finally:
        patch.write_text('[]\n')
        session.close()


if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    results = [run(request, mode, demo, interrupt)
               for mode in ['inline', 'fullscreen']
               for demo, interrupt in [(False, False), (False, True), (True, False)]]
    results += [remount(request, mode) for mode in ['inline', 'fullscreen']]
    print(json.dumps({'nativePluginPty': results}, indent=2))
