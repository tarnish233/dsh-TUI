#!/usr/bin/env python3
"""Independent CLI/PTY search + readline/cancel acceptance for /model. Demo only."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import struct
import sys
import termios

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Session = helper.Session


def resize(session, columns, rows):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ,
                struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)


def run(mode):
    session = Session(mode, 'model-picker')
    try:
        session.wait_for(b'ready')
        draft = b'PTY model picker retained draft'
        session.send(draft)
        session.wait_for(draft)
        opened = len(session.raw)
        session.send(b'\x1bp')  # Alt+P must not submit the original prompt.
        session.wait_for(b'Choose model', opened)
        session.wait_for(b'Demo model (offline)', opened)
        query = len(session.raw)
        session.send(b'not-a-matching-model')
        session.wait_for(b'No models match', query)
        inert = len(session.raw)
        session.send(b'\r')  # No hidden/stale selection may be confirmed.
        resize(session, 90, 32)
        session.wait_for(b'Choose model', inert)
        session.wait_for(b'No models match', inert)

        cleared = len(session.raw)
        session.send(b'\x17')  # Ctrl+W: whitespace readline kill at the query's end.
        session.wait_for(b'Demo model (offline)', cleared)
        yanked = len(session.raw)
        session.send(b'\x19')
        session.wait_for(b'No models match', yanked)
        restored = len(session.raw)
        session.send(b'\x1f')  # Undo yank restores the same empty query state.
        session.wait_for(b'Demo model (offline)', restored)
        narrow = len(session.raw)
        resize(session, 40, 22)
        session.wait_for(b'Choose model', narrow)
        session.send(b'\t\x1b[Z')
        wide = len(session.raw)
        resize(session, 110, 32)
        session.wait_for(b'Choose model', wide)

        closed = len(session.raw)
        session.send(b'\x1b')
        session.wait_for(draft, closed)
        session.wait_for(b'\x1b[7m \x1b[27m', closed)
        assert b'Working' not in session.raw[opened:], (mode, 'picker sent a prompt')
        armed = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', armed)
        session.send(b'\x03')
        result = session.finish(restore_offset=closed)
        result.update({'modelSearch': True, 'readlineKillYankUndo': True,
                       'emptyResultEnterInert': True, 'draftPreserved': True,
                       'resizeAndProviderKeys': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptyModelPickerAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
