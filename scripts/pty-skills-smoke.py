#!/usr/bin/env python3
"""Native /name completion and read-only Skills Help through the real offline CLI/PTY."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.OUT = helper.ROOT / '.cache' / 'skills' / 'pty'
helper.OUT.mkdir(parents=True, exist_ok=True)


class SkillSession(helper.Session):
    """Reuse owned PTY restore/query-reply machinery, with a private home and workspace."""
    def __init__(self, mode):
        self.mode = mode
        self.scenario = 'skills'
        self.config = tempfile.mkdtemp(prefix='dsh-skills-pty-')
        private = Path(self.config)
        home, workspace, settings = private / 'home', private / 'workspace', private / 'tui'
        for directory in (home, workspace, settings):
            directory.mkdir()
        self.raw = bytearray()
        self.status = None
        self.started = time.monotonic()
        self.columns, self.rows = 140, 58
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(workspace)
            env = {
                'PATH': os.environ.get('PATH', ''), 'HOME': str(home), 'DSH_HOME': str(home),
                'XDG_CONFIG_HOME': str(home / '.config'), 'LANG': 'en_US.UTF-8',
                'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'TERM_PROGRAM': 'rex',
                'CI': '1', 'DSH_TELEMETRY_DISABLED': '1',
            }
            os.execve(helper.NODE, [helper.NODE, str(helper.ROOT / 'bin/dsh-tui.mjs'), '--demo',
                                   '--' + mode, '--config-dir', str(settings), ' '], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                    struct.pack('HHHH', self.rows, self.columns, 0, 0))

    def resize(self, columns, rows):
        self.columns, self.rows = columns, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)


def frame(session):
    for _ in range(3):
        session.read(0.015)
    decoded = subprocess.run([helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'),
                              str(session.columns), str(session.rows)],
                             input=bytes(session.raw), capture_output=True, check=True, timeout=5)
    return json.loads(decoded.stdout)['lines']


def wait_frame(session, predicate, timeout=8):
    deadline = time.monotonic() + timeout
    lines = []
    while time.monotonic() < deadline:
        lines = frame(session)
        if predicate(lines):
            return lines
        assert not session.poll_exit(), session.tail()
    raise AssertionError('Skills frame timed out:\n' + '\n'.join(lines))


def run(mode):
    session = SkillSession(mode)
    try:
        session.wait_for(b'ready')
        session.send(b'/code')
        menu = wait_frame(session, lambda lines: any('code-review' in line and 'Skill' in line for line in lines))
        assert not any('Working' in line for line in menu), 'opening metadata must not start a turn'
        session.send(b'\t')
        accepted = wait_frame(session, lambda lines: any('❯ /code-review' in line for line in lines))
        assert not any('Working' in line for line in accepted), 'Tab must accept into the draft only'
        session.send(b'PTY native skill literal\r')
        first = wait_frame(session, lambda lines: 'Offline skill fixture' in '\n'.join(lines) and any(' · ready' in line for line in lines))
        assert any('/code-review' in line and 'PTY native skill literal' in line for line in first)
        assert 'skill:code-review' not in '\n'.join(first)

        draft = b'PTY Skills retained draft'
        session.send(draft)
        wait_frame(session, lambda lines: any('❯ PTY Skills retained draft' in line for line in lines))
        opened = len(session.raw)
        session.send(b'\x1bOP')  # F1; keep the editor and its exact draft.
        session.wait_for(b'Help', opened)
        session.send(b'\x1b[F')
        help_lines = wait_frame(session, lambda lines: any('Skills 4' in line for line in lines)
                                and any('/release-notes [user-only]' in line for line in lines))
        assert 'skill:release-notes' not in '\n'.join(help_lines)
        session.send(b'\r19\t')
        session.resize(100, 50)
        wait_frame(session, lambda lines: any('Skills 4' in line for line in lines)
                   and any('Help' in line for line in lines))
        session.send(b'\x1b')
        wait_frame(session, lambda lines: any('❯ PTY Skills retained draft' in line for line in lines))
        session.send(b'\x15')
        session.send(b'/release')
        wait_frame(session, lambda lines: any('release-notes' in line and 'Skill (user-only)' in line for line in lines))
        session.send(b'\t')
        wait_frame(session, lambda lines: any('❯ /release-notes' in line for line in lines))
        session.send(b'PTY explicit user-only skill\r')
        wait_frame(session, lambda lines: any('Offline skill fixture' in line and '/release-notes' in line for line in lines)
                   and any(' · ready' in line for line in lines))

        session.send(b'/compact')
        collision = wait_frame(session, lambda lines: any('compact' in line and 'Compact the demo session' in line for line in lines))
        assert not any('compact' in line and 'Fixture skill that reuses' in line for line in collision)
        session.send(b'\r')
        wait_frame(session, lambda lines: any('Demo compaction simulated' in line for line in lines)
                   and any(' · ready' in line for line in lines))
        armed = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', armed)
        session.send(b'\x03')
        result = session.finish(restore_offset=opened)
        result.update({'nativeNameCompletion': True, 'tabDoesNotSubmit': True,
                       'literalSkillPrompt': True, 'userOnlyMetadata': True,
                       'readonlyHelpPreservesDraft': True, 'commandCollisionWins': True,
                       'temporaryHomeAndWorkspace': True, 'modelCalls': 0})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptySkillsAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
