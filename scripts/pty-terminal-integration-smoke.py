#!/usr/bin/env python3
"""Built CLI/PTY acceptance for generic OSC 7501, Rex and Ghostty fallbacks.

Private HOME/workspace/settings only, zero model calls. Query responses are
parsed in wire order so the OSC 7501 capability reply arrives before its DA
sentinel. This is a protocol emulator, not proof of a Ghostty GUI popup.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import sys
import tempfile
import time

sys.dont_write_bytecode = True
PROJECT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.OUT = PROJECT / '.cache/rex-static-title/pty'
helper.OUT.mkdir(parents=True, exist_ok=True)
QUERY = b'\x1b]7501;?\x1b\\'
REPLY = b'\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
ACTIVE = b'\x1b]9;4;3\x07'
CLEAR = b'\x1b]9;4;0\x07'


class Session(helper.Session):
    def __init__(self, mode, family, support):
        self.support = support
        self.query_buffer = bytearray()
        self.query_count = 0
        super().__init__(mode, 'terminal-' + family, settings={'formatVersion': 2, 'copyOnSelect': False},
                         bindings={'app.interrupt': 'ctrl+q'})

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
        self.query_buffer.extend(data)
        responses = [(b'\x1b[?u', b'\x1b[?7u'), (QUERY, REPLY if self.support else None),
                     (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[6n', b'\x1b[1;1R'),
                     (b'\x1b[16t', b'\x1b[6;16;8t')]
        while True:
            matches = [(self.query_buffer.find(query), query, response) for query, response in responses
                       if self.query_buffer.find(query) >= 0]
            if not matches:
                # Only partial query tails are needed, never an unbounded screen buffer.
                if len(self.query_buffer) > 32:
                    del self.query_buffer[:-32]
                break
            offset, query, response = min(matches, key=lambda item: item[0])
            del self.query_buffer[:offset + len(query)]
            if query == QUERY:
                self.query_count += 1
            if response is not None:
                os.write(self.fd, response)

    def reports(self, offset=0):
        reports = []
        for match in re.finditer(rb'\x1b\]7501;([^\x1b\x07]*)(?:\x1b\\|\x07)', bytes(self.raw[offset:])):
            pairs = {}
            for pair in match.group(1).decode('ascii').split(':'):
                if '=' in pair:
                    key, value = pair.split('=', 1)
                    pairs[key] = value
            if 'state' in pairs and 'id' not in pairs:
                if 'msg' in pairs:
                    pairs['message'] = base64.b64decode(pairs['msg']).decode('utf8')
                reports.append(pairs)
        return reports

    def notices(self, offset=0):
        return [match.group(1).decode('utf8') for match in re.finditer(
            rb'\x1b\]777;notify;dsh-tui;([^\x1b\x07]*)\x07', bytes(self.raw[offset:]))]

    def wait_state(self, state, offset=0, timeout=8):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            rows = [row for row in self.reports(offset) if row['state'] == state]
            if rows:
                return rows[-1]
            self.read()
            assert not self.poll_exit(), self.tail()
        raise AssertionError((self.mode, self.scenario, 'missing state', state, self.tail()))

    def settle(self):
        until = time.monotonic() + 0.15
        while time.monotonic() < until:
            self.read(0.01)

    def turn(self, text):
        offset = len(self.raw)
        self.send(text.encode() + b'\r')
        if self.support:
            self.wait_state('working', offset)
            self.wait_state('done', offset)
        else:
            self.wait_for(ACTIVE, offset)
            self.wait_for(CLEAR, offset)
        self.settle()
        return offset


def run(mode, family):
    with tempfile.TemporaryDirectory(prefix='dsh-terminal-pty-home-') as home, tempfile.TemporaryDirectory(prefix='dsh-terminal-pty-cwd-') as cwd:
        # Do not inherit provider keys, user profiles, terminal logs or mux state.
        path = os.environ.get('PATH', '/opt/homebrew/bin:/usr/bin:/bin')
        tmpdir = os.environ.get('TMPDIR')
        os.environ.clear()
        os.environ.update({'PATH': path, 'HOME': home, 'USERPROFILE': home,
                           'DSH_HOME': str(Path(home) / '.dsh'), 'XDG_CONFIG_HOME': str(Path(home) / '.config'),
                           'TERM': 'xterm-ghostty' if family == 'ghostty' else 'xterm-256color',
                           'TERM_PROGRAM': 'ghostty' if family == 'ghostty' else ('rex' if family in ['rex', 'disabled'] else 'fixture'),
                           'COLORTERM': 'truecolor'})
        if tmpdir:
            os.environ['TMPDIR'] = tmpdir
        if family == 'disabled':
            os.environ['PI_PROGRAM_STATUS'] = '0'
        (Path(cwd) / 'bin').symlink_to(PROJECT / 'bin', target_is_directory=True)
        helper.ROOT = Path(cwd)
        supported = family in ['rex', 'generic']
        session = Session(mode, family, supported)
        try:
            session.wait_for(b'ready')
            session.settle()
            assert b'\x1b[?1004h' in session.raw
            expected_title = '\x1b]0;🐳 dsh-tui'.encode() if family in ['rex', 'disabled'] else b'\x1b]0;dsh-tui'
            assert expected_title in session.raw and b'\x1b]7;file://' in session.raw
            if supported:
                first_status = session.wait_state('idle')
                assert first_status['app'] == ('terminal' if family == 'rex' else 'dsh-tui')
                assert session.query_count == 1
            else:
                assert session.reports() == []
                assert session.query_count == (0 if family == 'disabled' else 1)
            session.send(b'\x1b[O')
            session.settle()
            first = session.turn('streaming terminal fixture')
            if supported:
                assert session.wait_state('done', first)['message'] == 'Turn complete'
                assert session.notices() == [], 'native rich-status attention must not get a second OSC 777 request'
                assert ACTIVE not in session.raw[first:]
            elif family == 'ghostty':
                assert session.notices(first) == ['Turn complete']
            else:
                assert session.notices() == []

            if family in ['rex', 'ghostty', 'generic']:
                before = len(session.raw)
                session.send(b'approval\r')
                session.wait_for(b'Allow this demo action?')
                session.settle()
                if supported:
                    assert session.wait_state('blocked', before)['kind'] == 'permission'
                else:
                    assert session.notices(before) == ['Waiting for approval']
                cancelled = len(session.raw)
                session.send(b'\x11')  # explicit native interrupt; default Ctrl+C is local to the dialog
                session.wait_for(b'ready', cancelled)
                session.settle()
                assert all(row['state'] not in ['done', 'error'] for row in session.reports(cancelled))
                assert session.notices(cancelled) == []

                before = len(session.raw)
                session.send(b'question\r')
                session.wait_for(b'Which demo colors do you want?')
                session.settle()
                if supported:
                    assert session.wait_state('blocked', before)['kind'] == 'question'
                else:
                    assert session.notices(before) == ['Waiting for your answer']
                cancelled = len(session.raw)
                session.send(b'\x11')  # explicit native interruption, not local question cancellation
                session.wait_for(b'ready', cancelled)
                session.settle()
                assert session.notices(cancelled) == []
                assert all(row['state'] not in ['done', 'error'] for row in session.reports(cancelled))

            if family == 'ghostty':
                # CSI I inside a bracketed paste must NOT change terminal focus.
                session.send(b'\x1b[200~literal focus \x1b[I\x1b[201~')
                session.settle()
                session.send(b'\x03')
                session.settle()
                pasted = session.turn('streaming paste isolation')
                assert session.notices(pasted) == ['Turn complete']
                # A physical focus gain does suppress future automatic alerts.
                session.send(b'\x1b[I')
                session.settle()
                focused = session.turn('streaming focused fixture')
                assert session.notices(focused) == []
                assert session.reports() == []

            before_exit = len(session.raw)
            session.send(b'\x03'); session.settle(); session.send(b'\x03')
            result = session.finish(restore_offset=before_exit)
            suffix = bytes(session.raw[before_exit:])
            assert b'\x1b[?1004l' in suffix
            assert CLEAR not in suffix or ACTIVE not in suffix
            if supported:
                assert any(row['state'] == 'clear' for row in session.reports(before_exit))
            result.update({'family': family, 'programStatusSupported': supported,
                           'genericNegotiation': True, 'nativeDecisionKinds': family != 'disabled',
                           'focusPasteIsolation': family == 'ghostty', 'explicitNotifications': session.notices(),
                           'protocolOptOut': family == 'disabled', 'modelCalls': 0,
                           'privateHomeAndWorkspace': True})
            return result
        finally:
            session.close()


if __name__ == '__main__':
    modes = sys.argv[1:] or ['inline', 'fullscreen']
    assert all(mode in ['inline', 'fullscreen'] for mode in modes)
    print(json.dumps({'ptyTerminalIntegrationAcceptance': [run(mode, family) for mode in modes
                                                          for family in ['rex', 'generic', 'ghostty', 'disabled']]}, indent=2))
