#!/usr/bin/env python3
"""Independent foreground CLI cancellation acceptance. Demo only; no model calls.

Checks raw Ctrl+C separately from external SIGINT, and exercises real Pi focus
routing in inline/fullscreen terminals. Configuration and artifacts are isolated.
"""
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
NODE = shutil.which('node')
assert NODE, 'node is required'


class Session:
    # /help now opens a modal. A whitespace prompt also suppresses the CLI's
    # automatic --demo tools example, and App ignores it without starting a turn.
    def __init__(self, mode, scenario, prompt=' ', settings=None):
        self.mode = mode
        self.scenario = scenario
        self.config = tempfile.mkdtemp(prefix='dsh-cancel-pty-')
        if settings is not None:
            # Written before the fork so the child reads it at startup; keeps
            # scenario-specific preferences isolated to the temp config dir.
            (Path(self.config) / 'settings.json').write_text(
                json.dumps(settings), encoding='utf8')
        self.raw = bytearray()
        self.status = None
        self.started = time.monotonic()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(ROOT)
            os.execv(NODE, [NODE, str(ROOT / 'bin/dsh-tui.mjs'), '--demo',
                           '--' + mode, '--config-dir', self.config, prompt])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                    struct.pack('HHHH', 32, 110, 0, 0))

    def read(self, timeout=0.02):
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if not ready:
            return
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            return
        if not data:
            return
        self.raw.extend(data)
        # Simulate standard terminal query replies, not clipboard operations.
        for query, answer in [(b'\x1b[c', b'\x1b[?1;2c'),
                              (b'\x1b[?u', b'\x1b[?0u'),
                              (b'\x1b[6n', b'\x1b[1;1R'),
                              (b'\x1b[16t', b'\x1b[6;16;8t')]:
            if query in data:
                try:
                    os.write(self.fd, answer)
                except OSError:
                    pass

    def poll_exit(self):
        if self.status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = status
        return self.status is not None

    def wait_for(self, marker, offset=0, timeout=6):
        deadline = time.monotonic() + timeout
        while marker not in self.raw[offset:]:
            self.read()
            assert not self.poll_exit(), (self.mode, self.scenario,
                                          'exited before marker', marker,
                                          self.tail())
            assert time.monotonic() < deadline, (self.mode, self.scenario,
                                                'missing marker', marker,
                                                self.tail())

    def send(self, data):
        os.write(self.fd, data)

    def tail(self):
        return bytes(self.raw[-2500:]).decode('utf8', 'replace')

    def assert_restored(self, offset=0):
        suffix = bytes(self.raw[offset:])
        assert b'\x1b[?2004l' in suffix, (self.mode, 'paste mode not restored')
        assert b'\x1b[?25h' in suffix, (self.mode, 'cursor not restored')
        if self.mode == 'fullscreen':
            assert b'\x1b[?1049l' in suffix, (self.mode, 'alternate screen not restored')

    def finish(self, code=0, restore_offset=0):
        deadline = time.monotonic() + 5
        while not self.poll_exit():
            self.read()
            assert time.monotonic() < deadline, (self.mode, self.scenario,
                                                'exit deadline exceeded', self.tail())
        # Read terminal cleanup bytes even when waitpid wins the last race.
        for _ in range(6):
            self.read(0.01)
        actual = os.waitstatus_to_exitcode(self.status)
        assert actual == code, (self.mode, self.scenario, actual, self.tail())
        self.assert_restored(restore_offset)
        return {'mode': self.mode, 'scenario': self.scenario, 'exit': actual,
                'durationSeconds': round(time.monotonic() - self.started, 2),
                'bytes': len(self.raw), 'terminalRestored': True}

    def close(self):
        try:
            if not self.poll_exit():
                os.kill(self.pid, signal.SIGKILL)
                _, self.status = os.waitpid(self.pid, 0)
        finally:
            OUT.mkdir(exist_ok=True)
            (OUT / ('pty-cancel-' + self.mode + '-' + self.scenario + '.ansi')).write_bytes(self.raw)
            os.close(self.fd)
            shutil.rmtree(self.config, ignore_errors=True)


def idle_clear_exit(mode):
    session = Session(mode, 'idle-clear-exit')
    try:
        session.wait_for(b'ready')
        session.send(b'PTY clear then exit draft')
        session.wait_for(b'PTY clear then exit draft')
        offset = len(session.raw)
        session.send(b'\x03')
        # A first press must clear rather than exit. No third key is allowed.
        deadline = time.monotonic() + 0.06
        while time.monotonic() < deadline:
            session.read(0.01)
        assert not session.poll_exit(), (mode, 'first Ctrl+C exited')
        session.send(b'\x03')
        return session.finish(restore_offset=offset)
    finally:
        session.close()


def external_sigint(mode):
    session = Session(mode, 'external-sigint', 'approval')
    try:
        session.wait_for(b'Allow this demo action?')
        offset = len(session.raw)
        os.kill(session.pid, signal.SIGINT)
        return session.finish(code=130, restore_offset=offset)
    finally:
        session.close()


def question_escape_cancels_natively(mode):
    # CC/Pi semantics: Esc settles the question natively (no hidden state, no
    # /questions reopen command anymore).
    session = Session(mode, 'question-escape-cancel')
    try:
        session.wait_for(b'ready')
        session.send(b'question\r')
        session.wait_for(b'Which demo colors do you want?')
        session.send(b'1')
        offset = len(session.raw)
        session.send(b'\x1b')
        session.wait_for(b'Demo question cancelled', offset)
        session.wait_for(b'ready', offset)
        assert b'Recorded demo answers' not in session.raw[offset:]
        assert b'unexpected demo answer' not in session.raw[offset:]
        assert b'/questions' not in session.raw
        session.send(b'\x03')
        session.read(0.03)
        session.send(b'\x03')
        return session.finish(restore_offset=offset)
    finally:
        session.close()


def busy_settings_interrupt(mode):
    session = Session(mode, 'busy-settings-interrupt')
    try:
        session.wait_for(b'ready')
        offset = len(session.raw)
        session.send(b'PTY ordinary streaming response\r')
        session.wait_for(b'Working', offset)
        offset = len(session.raw)
        session.send(b'/settings\r')
        session.wait_for(b'Keyboard shortcuts', offset)
        offset = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'ready', offset)
        # Global interruption may leave a generic Settings surface visible.
        # Close that local layer explicitly before testing idle exit keys.
        escape_offset = len(session.raw)
        session.send(b'\x1b')
        # read(timeout) may return immediately on any available output; it is
        # not a delay. Wait for prompt focus so a lone legacy Esc has resolved
        # before sending Ctrl+C (otherwise the bytes can become Alt+Ctrl+C).
        # Pi draws its focused empty editor with an inverse-space caret; it
        # intentionally keeps the hardware cursor hidden during rendering.
        session.wait_for(b'\x1b[7m \x1b[27m', escape_offset)
        arm_offset = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', arm_offset)
        session.send(b'\x03')
        return session.finish(restore_offset=offset)
    finally:
        session.close()


if __name__ == '__main__':
    results = []
    for mode in ('inline', 'fullscreen'):
        for scenario in (idle_clear_exit, external_sigint,
                         question_escape_cancels_natively, busy_settings_interrupt):
            results.append(scenario(mode))
    print(json.dumps({'ptyCancellationAcceptance': results}, indent=2))
