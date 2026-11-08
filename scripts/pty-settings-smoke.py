#!/usr/bin/env python3
"""Single-page Settings through the real offline CLI and independent VT cells.

Temporary home/workspace/config only; no native profile, model call or system
clipboard. Fullscreen also exercises real SGR press/release routing, checks that
invisible presses do not repaint, and records release-to-first-repaint latency.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.OUT = PROJECT / '.cache/settings-single-page/pty'
helper.OUT.mkdir(parents=True, exist_ok=True)
SECTIONS = ['General', 'Thinking', 'Tools & Diff', 'Agents', 'Images', 'DSH', 'Keyboard']
FIRST_ROWS = ['Default screen', 'Show thinking', 'Group tool calls', 'Progress above input',
              'Viewer preview', 'Current model', 'Keyboard shortcuts']


def settle(session):
    quiet = 0
    deadline = time.monotonic() + 0.5
    while quiet < 3 and time.monotonic() < deadline:
        before = len(session.raw)
        session.read(0.015)
        quiet = quiet + 1 if before == len(session.raw) else 0


def frame(session, columns, rows):
    settle(session)
    result = subprocess.run([helper.NODE, str(PROJECT / 'scripts/ansi-screen.ts'), str(columns), str(rows)],
                            input=bytes(session.raw), capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)


def resize(session, columns, rows):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)


def panel(screen, title='Settings'):
    lines = screen['lines']
    start = next((i for i, line in enumerate(lines) if '┌─ ' + title in line), None)
    assert start is not None, ('missing modal', title, lines)
    end = next((i for i in range(start + 1, len(lines)) if '└' in lines[i] and '┘' in lines[i]), None)
    assert end is not None, ('clipped modal', title, lines)
    return lines[start:end + 1]


def assert_selected(screen, label):
    assert any('❯' in line and label in line for line in panel(screen)), ('selected row', label, panel(screen))


def click_point(screen, label):
    for y, line in enumerate(screen['lines']):
        if label in line:
            return line.index(label) + 1, y
    raise AssertionError(('missing click row', label, screen['lines']))


def run(mode):
    with tempfile.TemporaryDirectory(prefix='dsh-settings-home-') as home, tempfile.TemporaryDirectory(prefix='dsh-settings-cwd-') as cwd:
        os.environ.update({'HOME': home, 'DSH_HOME': str(Path(home) / '.dsh'),
                           'XDG_CONFIG_HOME': str(Path(home) / '.config'),
                           'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'})
        # Reuse the owned lifecycle helper with a private cwd; Node follows the
        # local bin symlink back to this checkout's built application sources.
        (Path(cwd) / 'bin').symlink_to(PROJECT / 'bin', target_is_directory=True)
        helper.ROOT = Path(cwd)
        session = helper.Session(mode, 'settings-single-page', prompt='/settings',
                                 settings={'formatVersion': 2, 'copyOnSelect': False})
        try:
            columns, rows = 120, 80
            session.wait_for(b'Settings')
            resize(session, columns, rows)
            first = frame(session, columns, rows)
            content = panel(first)
            for section in SECTIONS:
                assert any(section in line and all(other not in line for other in SECTIONS if other != section)
                           for line in content), ('missing separate section heading', section, content)
            assert_selected(first, 'Default screen')
            saved = (Path(session.config) / 'settings.json').read_bytes()

            session.send(b'\t')
            assert_selected(frame(session, columns, rows), 'Show thinking')
            session.send(b'\x1b[Z')
            assert_selected(frame(session, columns, rows), 'Default screen')
            session.send(b'\x1b[C')
            assert_selected(frame(session, columns, rows), 'Show thinking')
            session.send(b'\x1b[D')
            assert_selected(frame(session, columns, rows), 'Default screen')
            for label in FIRST_ROWS[1:]:
                session.send(b'\t')
                assert_selected(frame(session, columns, rows), label)
            session.send(b'\r')
            assert 'Keyboard shortcuts' in '\n'.join(panel(frame(session, columns, rows), 'Keyboard shortcuts'))
            session.send(b'\x1b')
            assert_selected(frame(session, columns, rows), 'Keyboard shortcuts')

            session.send(b'\x06group')
            filtered = '\n'.join(panel(frame(session, columns, rows)))
            assert 'Group tool calls' in filtered and 'Group agent messages' in filtered, filtered
            session.send(b'\x15')
            frame(session, columns, rows)
            session.send(b'\x1b')
            frame(session, columns, rows)
            session.send(b'\x1b[H')
            assert_selected(frame(session, columns, rows), 'Default screen')

            latencies = []
            if mode == 'fullscreen':
                for _ in range(4):
                    screen = frame(session, columns, rows)
                    x, y = click_point(screen, 'Default screen')
                    before = len(session.raw)
                    session.send(f'\x1b[<0;{x + 1};{y + 1}M'.encode())
                    settle(session)
                    assert len(session.raw) == before, 'pin-only mouse press must not repaint'
                    start = time.monotonic()
                    session.send(f'\x1b[<0;{x + 1};{y + 1}m'.encode())
                    deadline = start + 3
                    while len(session.raw) == before:
                        session.read(0.005)
                        assert not session.poll_exit() and time.monotonic() < deadline, 'picker click stalled'
                    latencies.append(round((time.monotonic() - start) * 1000, 2))
                    assert 'Settings › Default screen' in '\n'.join(panel(frame(session, columns, rows)))
                    session.send(b'\x1b')
                    assert_selected(frame(session, columns, rows), 'Default screen')

            resize(session, 40, 20)
            frame(session, 40, 20)
            session.send(b'\x1b[F')
            assert_selected(frame(session, 40, 20), 'Keyboard shortcuts')
            session.send(b'\x1b[H')
            frame(session, 40, 20)
            # General is a continuous roster, not a fixed tab/page. New
            # terminal preferences must not turn this into a page-local test.
            for _ in range(16):
                current = frame(session, 40, 20)
                if any('❯' in line and 'Show thinking' in line for line in panel(current)):
                    break
                session.send(b'\x1b[B')
            else:
                raise AssertionError('Down did not cross General into Thinking')
            assert_selected(frame(session, 40, 20), 'Show thinking')
            assert (Path(session.config) / 'settings.json').read_bytes() == saved, 'navigation never writes preferences'
            session.send(b'\x1b')
            closed = len(session.raw)
            session.wait_for(b'\x1b[7m \x1b[27m', closed)
            session.send(b'PTY settings returned draft')
            session.wait_for(b'PTY settings returned draft', closed)
            armed = len(session.raw)
            session.send(b'\x03')
            session.wait_for(b'again to exit', armed)
            session.send(b'\x03')
            result = session.finish(restore_offset=closed)
            result.update({'singlePage': True, 'tabShiftTabAndArrowSectionJumps': True,
                           'crossSectionSearch': True, 'keyboardBackPosition': True,
                           'resizeAndCrossGroupRows': True, 'navigationReadOnly': True,
                           'mousePressNoRepaint': mode == 'fullscreen',
                           'mousePickerRoundTrips': len(latencies),
                           'releaseToFirstRepaintMs': latencies,
                           'temporaryHomeAndWorkspace': True, 'modelCalls': 0})
            return result
        finally:
            session.close()


if __name__ == '__main__':
    modes = sys.argv[1:] or ['inline', 'fullscreen']
    assert all(mode in ['inline', 'fullscreen'] for mode in modes)
    print(json.dumps({'ptySettingsAcceptance': [run(mode) for mode in modes]}, indent=2))
