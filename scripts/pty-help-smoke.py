#!/usr/bin/env python3
"""Independent read-only Help acceptance through the real CLI/PTY. Demo only."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import struct
import sys
import termios

# Reuse only the owned PTY lifecycle/query-reply helper, without running its tests.
# The existing script has a hyphenated filename, so load it by its exact path.
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


def readonly_help(mode):
    session = Session(mode, 'help-readonly')
    try:
        session.wait_for(b'ready')
        draft = b'PTY Help retained draft'
        session.send(draft)
        session.wait_for(draft)
        opened = len(session.raw)
        session.send(b'\x1bOP')  # F1; does not submit the existing draft.
        session.wait_for(b'Help', opened)
        session.wait_for(b'Custom commands', opened)
        session.wait_for(b'Commands', opened)

        inert = len(session.raw)
        session.send(b'\r19\t\x1b[Z')
        # A resize forces a new render, proving inert keys left the panel open.
        resize(session, 120, 36)
        session.wait_for(b'Help', inert)
        session.wait_for(b'Custom commands', inert)
        assert b'Working' not in session.raw[opened:], (mode, 'Help started a turn')

        narrow = len(session.raw)
        resize(session, 40, 20)
        session.wait_for(b'Help', narrow)
        session.send(b'\x1b[F')  # Browse the bottom of the stacked sections.
        wide = len(session.raw)
        resize(session, 110, 32)
        session.wait_for(b'Help', wide)

        closed = len(session.raw)
        session.send(b'\x1b')
        session.wait_for(draft, closed)
        session.wait_for(b'\x1b[7m \x1b[27m', closed)
        assert draft + b'19' not in session.raw[closed:], (mode, 'Help modified the prompt')
        assert b'Working' not in session.raw[opened:], (mode, 'Help submitted the prompt')

        armed = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', armed)
        session.send(b'\x03')
        result = session.finish(restore_offset=closed)
        result.update({'readonlyHelp': True, 'draftPreserved': True,
                       'inertEnterAndDigits': True, 'resizeAndBrowse': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptyHelpAcceptance': [readonly_help('inline'),
                                           readonly_help('fullscreen')]}, indent=2))
