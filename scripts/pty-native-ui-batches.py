#!/usr/bin/env python3
"""Explicit offline App/input PTY QA; production native APIs have separate tests."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which('node')
assert NODE
OUT = ROOT / '.cache/native-ui-expansion/pty'
OUT.mkdir(parents=True, exist_ok=True)

class Session:
    def __init__(self, mode, fixture='native-ui-pty.ts', demo_scenario=None):
        self.mode = mode
        self.home = tempfile.TemporaryDirectory(prefix='dsh-native-ui-pty-')
        self.directory = Path(self.home.name)
        self.raw = bytearray()
        self.status = None
        self.cols, self.rows = 100, 28
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            env = {**os.environ, 'HOME': self.home.name, 'DSH_HOME': self.home.name,
                   'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'}
            os.chdir(self.home.name)
            if demo_scenario is None:
                argv = [NODE, str(ROOT / 'test/fixtures' / fixture), self.home.name,
                        str(self.directory / 'config'), str(self.directory / 'result.json'), mode]
            else:
                # Exercise the public alias, with an unusable native command to
                # prove an explicit demo never starts or attaches native DSH.
                argv = [NODE, str(ROOT / 'bin/dsh-tui.mjs'), '--demo',
                        '--inline' if mode == 'inline' else '--fullscreen',
                        '--cwd', self.home.name, '--config-dir', str(self.directory / 'config'),
                        '--dsh', str(self.directory / 'no-native-dsh-here'), demo_scenario]
            os.execve(NODE, argv, env)
        self.resize(100, 28)

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)

    def send(self, data): os.write(self.fd, data)
    def read(self, timeout=0.05):
        if select.select([self.fd], [], [], timeout)[0]:
            try: self.raw.extend(os.read(self.fd, 65536))
            except OSError: pass
        if self.status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid: self.status = status

    def frame(self):
        self.read(0.05)
        # A PTY read may stop halfway through one renderer write. Respect the
        # synchronized-output frame boundary instead of asserting partial VT
        # rows (headless xterm does not buffer DEC 2026 itself).
        deadline = time.monotonic() + 3
        while True:
            while select.select([self.fd], [], [], 0)[0]:
                before = len(self.raw)
                self.read(0)
                if len(self.raw) == before:
                    break
            if self.raw.rfind(b'\x1b[?2026h') <= self.raw.rfind(b'\x1b[?2026l'):
                break
            assert self.status is None and time.monotonic() < deadline, 'unfinished synchronized-output frame'
            self.read(0.01)
        output = subprocess.run([NODE, str(ROOT / 'scripts/ansi-screen.ts'), str(self.cols), str(self.rows)],
                                input=bytes(self.raw), capture_output=True, check=True, timeout=8)
        return json.loads(output.stdout)['lines']

    def wait(self, predicate, timeout=8):
        end = time.monotonic() + timeout
        lines = []
        while time.monotonic() < end:
            lines = self.frame()
            if predicate(lines): return lines
            assert self.status is None, f'early exit: {self.status}\n' + '\n'.join(lines)
        raise AssertionError('PTY view timed out:\n' + '\n'.join(lines))

    def close(self):
        if self.status is None:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        os.close(self.fd)
        (OUT / ('native-ui-' + self.mode + '.ansi')).write_bytes(self.raw)
        self.home.cleanup()


def run(mode):
    s = Session(mode)
    try:
        s.wait(lambda rows: any('ready' in line for line in rows))
        s.send(b'history\r')
        s.wait(lambda rows: any('PTY FIXED TODO' in line for line in rows))
        s.send(b'PTY kept draft')
        rows = s.wait(lambda rows: any('PTY kept draft' in line for line in rows))
        todo = next(i for i, line in enumerate(rows) if 'PTY FIXED TODO' in line)
        editor = next(i for i, line in enumerate(rows) if 'PTY kept draft' in line)
        assert 0 <= todo < editor, '\n'.join(rows)
        assert sum('PTY FIXED TODO' in line for line in rows) == 1
        s.send(b'\x14')
        s.wait(lambda rows: not any('PTY FIXED TODO' in line for line in rows) and any('PTY kept draft' in line for line in rows))
        s.send(b'\x14')
        s.wait(lambda rows: any('PTY FIXED TODO' in line for line in rows))
        s.send(b'\x15update\r')
        s.wait(lambda rows: any('PTY updated step' in line for line in rows))
        s.send(b'PTY kept draft')
        s.resize(42, 18)
        s.wait(lambda rows: any('PTY kept draft' in line for line in rows) and any('PTY updated step' in line for line in rows))
        s.resize(100, 28)
        s.send(b'\x1bOP')  # F1, existing Help; use Settings via its UI command below.
        s.wait(lambda rows: any('Help' in line for line in rows))
        s.send(b'\x1b')
        s.wait(lambda rows: not any('┌─ Help' in line for line in rows)
               and any('PTY kept draft' in line for line in rows))
        s.send(b'\x15/settings\r')
        s.wait(lambda rows: any('Settings' in line for line in rows))
        assert b'\x1b[48;2;17;17;19m' not in s.raw, 'private black modal plate leaked'
        s.send(b'\x1b')
        s.wait(lambda rows: not any('┌─ Settings' in line for line in rows)
               and any('fixture-only/no-model-calls' in line for line in rows))
        (s.directory / 'pty-file.bin').write_bytes(bytes([0, 1, 2, 3, 254, 255]))
        s.send(b'\x15/attach pty-file.bin\r')
        s.wait(lambda rows: any('[File #1]' in line for line in rows))
        s.send(b'\r')
        end = time.monotonic() + 8
        while not (s.directory / 'result.json').exists():
            s.read()
            assert time.monotonic() < end, 'file-only multipart result missing'
        record = json.loads((s.directory / 'result.json').read_text())
        assert record['nativeFixtureOnly'] is True
        assert [part['type'] for part in record['content']] == ['file'], record
        assert record['content'][0]['attachment']['bytes'] == 6
        restored = len(s.raw)
        s.send(b'\x15/exit\r')
        end = time.monotonic() + 8
        while s.status is None:
            s.read()
            assert time.monotonic() < end, 'exit hung'
        assert os.waitstatus_to_exitcode(s.status) == 0
        tail = s.raw[restored:]
        assert b'\x1b[?2004l' in tail and b'\x1b[?25h' in tail, 'terminal state not restored'
        if mode == 'fullscreen': assert b'\x1b[?1049l' in tail
        return {'mode': mode, 'todoFixed': True, 'toggleAndUpdate': True, 'resizeKeepsEditor': True,
                'settingsSharesCanvas': True, 'fileMultipart': True, 'terminalRestored': True, 'models': False,
                'nativeApiTestedHere': False, 'explicitFixtureOnly': True}
    finally: s.close()

if __name__ == '__main__':
    print(json.dumps({'ptyNativeUiBatches': [run('inline'), run('fullscreen')]}, indent=2))
