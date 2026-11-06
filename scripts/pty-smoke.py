#!/usr/bin/env python3
"""Foreground PTY acceptance for the runnable CLI. Demo only; no model calls."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts'
OUT.mkdir(exist_ok=True)
NODE = shutil.which('node')
assert NODE, 'node is required'


def run(mode):
    config = tempfile.mkdtemp(prefix='dsh-pi-pty-')
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execv(NODE, [NODE, str(ROOT / 'bin/dsh-tui.mjs'), '--demo', '--' + mode,
                           '--config-dir', config, 'PTY streaming demonstration'])
    records, raw = [], bytearray()
    started = time.monotonic()
    resized_small = resized_large = typed = False
    exits = 0
    last_exit = 0
    status = None
    keyboard_stage = 0
    keyboard_saved = False
    keyboard_offset = 0
    keyboard_at = 0

    def resize(cols, rows):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        records.append({'kind': 'resize', 'cols': cols, 'rows': rows})

    resize(100, 35)
    try:
        while time.monotonic() - started < 12:
            elapsed = time.monotonic() - started
            readable, _, _ = select.select([fd], [], [], 0.03)
            if readable:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                raw.extend(data)
                records.append({'kind': 'output', 'data': base64.b64encode(data).decode('ascii')})
                # Real terminals answer these capability queries. No clipboard is read.
                if b'\x1b[c' in data:
                    os.write(fd, b'\x1b[?1;2c')
                if b'\x1b[?u' in data:
                    os.write(fd, b'\x1b[?0u')
                if b'\x1b[6n' in data:
                    os.write(fd, b'\x1b[1;1R')
                if b'\x1b[16t' in data:
                    os.write(fd, b'\x1b[6;16;8t')
            if not typed and elapsed > 0.35 and b'DEMO' in raw:
                os.write(fd, b'PTY keyboard draft\x01\x06\x0b\x19\x13\x13')
                typed = True
            # Exercise the actual Settings UI, not a direct config write or
            # component-only fixture. All files stay in this temporary home.
            if typed and keyboard_stage == 0 and elapsed > 0.65:
                os.write(fd, b'\x03')  # Cancel the initial demo turn.
                keyboard_stage = 1
            elif keyboard_stage == 1 and elapsed > 0.8:
                os.write(fd, b'\x03')  # Clear the keyboard draft.
                keyboard_stage = 2
            elif keyboard_stage == 2 and elapsed > 0.95:
                keyboard_offset = len(raw)
                os.write(fd, b'/settings\r')
                keyboard_stage = 3
            elif keyboard_stage == 3 and b'Keyboard shortcuts' in raw[keyboard_offset:]:
                # The tabbed Settings list no longer prints SelectDialog's
                # numeric labels. Keyboard shortcuts is last on General:
                # End selects it, Enter opens it, Enter edits its first binding.
                keyboard_offset = len(raw)
                os.write(fd, b'\x1b[F\r\r')
                keyboard_stage = 4
            elif keyboard_stage == 4 and b'One binding per line' in raw[keyboard_offset:]:
                keyboard_offset = len(raw)
                os.write(fd, b'\x15' * 4 + b'ctrl+q\r')
                keyboard_stage = 5
            elif keyboard_stage == 5 and b'Saved' in raw[keyboard_offset:]:
                try:
                    saved = json.loads((Path(config) / 'keybindings.json').read_text())
                except (OSError, ValueError):
                    saved = None
                if saved == {'editor.move.line-start': ['ctrl+q']}:
                    os.write(fd, b'\x1b')
                    keyboard_at = elapsed
                    keyboard_stage = 6
            elif keyboard_stage == 6 and elapsed - keyboard_at > 0.1:
                os.write(fd, b'\x1b')
                keyboard_at = elapsed
                keyboard_stage = 7
            elif keyboard_stage == 7 and elapsed - keyboard_at > 0.1:
                keyboard_offset = len(raw)
                os.write(fd, b'PTY streaming after keyboard settings\r')
                keyboard_stage = 8
            elif keyboard_stage == 8 and b'Working' in raw[keyboard_offset:]:
                keyboard_saved = True
                keyboard_stage = 9
            if elapsed > 1.2 and not resized_small:
                resize(40, 20)
                resized_small = True
            if elapsed > 1.5 and not resized_large:
                resize(100, 35)
                resized_large = True
            if elapsed > 3.2 and keyboard_stage == 9 and exits < 6 and elapsed - last_exit > 0.2:
                # Cancel a running turn, clear a draft, then confirm exit.
                os.write(fd, b'\x03')
                exits += 1
                last_exit = elapsed
            waited, child_status = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = child_status
                break
        if status is None:
            waited, child_status = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = child_status
            else:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    waited, child_status = os.waitpid(pid, os.WNOHANG)
                    if waited:
                        status = child_status
                        break
                    time.sleep(0.02)
                if status is None:
                    os.kill(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
        output = bytes(raw)
        (OUT / ('pty-' + mode + '.ansi')).write_bytes(output)
        (OUT / ('pty-' + mode + '.json')).write_text(json.dumps(records), encoding='utf8')
        code = os.waitstatus_to_exitcode(status)
        assert code == 0, (mode, code, output[-3000:].decode('utf8', 'replace'))
        assert typed and resized_small and resized_large, (mode, 'scenario did not execute')
        assert keyboard_saved and keyboard_stage == 9, (mode, 'Settings keyboard edit did not complete', keyboard_stage)
        assert b'\x1b[?2004l' in output, (mode, 'bracketed paste not restored')
        assert b'\x1b[?25h' in output, (mode, 'cursor not restored')
        if mode == 'fullscreen':
            assert b'\x1b[?1049l' in output, (mode, 'alternate screen not restored')
        return {'mode': mode, 'exit': code, 'bytes': len(output), 'durationSeconds': round(time.monotonic() - started, 2),
                'syncFrames': output.count(b'\x1b[?2026h'), 'inputAndResize': True, 'terminalRestored': True,
                'keyboardSettingsSaved': keyboard_saved}
    finally:
        os.close(fd)
        shutil.rmtree(config, ignore_errors=True)


print(json.dumps({'ptyAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
