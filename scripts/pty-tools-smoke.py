#!/usr/bin/env python3
"""Offline tools UI acceptance through the real CLI/PTy and independent VT cells.

No DSH provider calls, real tools or user configuration. No system clipboard
operations: Copy is verified via injected hooks in parent App tests, and native
selection OSC 52 bytes stay captured in this PTY rather than reaching a desktop.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import termios
import time

sys.dont_write_bytecode = True
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location('pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Session = helper.Session

GROUP = re.compile(r'^\s*[●◌]\s*(?:Bash|Multiple Tools):')
DEFAULT_SETTINGS = {'groupTools': True, 'showThinking': False, 'expandTools': False,
                    'expandedInputMaxLines': 5, 'expandedOutputMaxLines': 10}


def settle(session, limit=0.35):
    quiet = 0
    while quiet < 3 and limit > 0:
        before = len(session.raw)
        session.read(0.05)
        quiet = quiet + 1 if before == len(session.raw) else 0
        limit -= 0.05


def frame(session, columns=80, rows=32):
    settle(session)
    decoded = subprocess.run([helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'),
                              str(columns), str(rows)], input=bytes(session.raw),
                             capture_output=True, check=True, timeout=5)
    return json.loads(decoded.stdout)


def resize(session, columns, rows):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)
    settle(session)


def text(screen):
    return '\n'.join(screen['lines'])


def group_rows(screen):
    return [i for i, line in enumerate(screen['lines']) if GROUP.match(line)]


def click(session, x, y):
    session.send(f'\x1b[<0;{x + 1};{y + 1}M'.encode())
    settle(session)
    session.send(f'\x1b[<0;{x + 1};{y + 1}m'.encode())
    settle(session)


def wheel_until(session, direction, predicate, steps=28):
    screen = frame(session)
    for _ in range(steps):
        if predicate(screen):
            return screen
        session.send(f'\x1b[<{direction};5;12M'.encode())
        screen = frame(session)
    assert predicate(screen), text(screen)
    return screen


def run_flow(session):
    session.wait_for(b'ready')
    resize(session, 80, 32)
    session.send(b'tools-group')
    session.wait_for(b'tools-group')
    begin = len(session.raw)
    session.send(b'\r')
    session.wait_for(b'no MCP server', offset=begin, timeout=30)
    deadline = time.monotonic() + 10
    while True:
        screen = frame(session)
        if re.search(r'\bready\b', text(screen)) and 'No command ran' in text(screen):
            return screen
        assert time.monotonic() < deadline, 'tools demo did not paint its idle completion'


def exit_idle(session):
    begin = len(session.raw)
    session.send(b'\x03')
    session.wait_for(b'again to exit', offset=begin)
    session.send(b'\x03')
    return session.finish(restore_offset=begin)


def fullscreen():
    session = Session('fullscreen', 'tools-group-details', settings=DEFAULT_SETTINGS)
    try:
        run_flow(session)
        collapsed = wheel_until(session, 64, lambda s: bool(group_rows(s)))
        rows = group_rows(collapsed)
        assert len(rows) == 1, text(collapsed)
        y = rows[0]
        header = collapsed['lines'][y]
        assert '3 done' in header and 'click to show more' in header
        x = header.index('click to show more') + 4
        assert 'bash-one output line 1' not in text(collapsed)
        for _ in range(2):
            click(session, x, y)
            expanded = frame(session)
            assert group_rows(expanded) == [y], 'expanded group header moved off its pressed row'
            assert 'click to collapse' in expanded['lines'][y]
            assert all(i > y for i, line in enumerate(expanded['lines']) if 'Back to bottom' in line)
            click(session, x, y)
            folded = frame(session)
            assert group_rows(folded) == [y]
            assert 'click to show more' in folded['lines'][y]
            assert 'bash-one output line 1' not in text(folded)
        click(session, x, y)

        def first_output_footer(s):
            body = text(s)
            return ('bash-one output line 1' in body
                    and any('more lines' in line and 'click to show details' in line
                            and not re.search(r'│\s*│', line) for line in s['lines']))

        body = wheel_until(session, 65, first_output_footer)
        output_row = next(i for i, line in enumerate(body['lines']) if 'bash-one output line 1' in line)
        output_col = body['lines'][output_row].index('bash-one output line 1')
        session.send(f'\x1b[<0;{output_col + 1};{output_row + 1}M'.encode())
        settle(session)
        session.send(f'\x1b[<32;{output_col + 14};{output_row + 1}M'.encode())
        settle(session)
        selected = frame(session)
        assert any(selected['attributes'][output_row][column][2]
                   for column in range(output_col, min(80, output_col + 13))), 'native first drag did not paint a selection'
        session.send(f'\x1b[<0;{output_col + 14};{output_row + 1}m'.encode())
        selected = frame(session)
        assert 'bash-one output line 1' in text(selected), 'drag incorrectly collapsed the group'

        footer_row = next(i for i, line in enumerate(selected['lines'])
                          if 'more lines' in line and 'click to show details' in line
                          and not re.search(r'│\s*│', line))
        footer = selected['lines'][footer_row]
        click(session, footer.index('click to show details') + 4, footer_row)
        details = frame(session)
        assert 'Tool details' in text(details)
        assert 'bash-one output line 1' in text(details), 'non-last group Output opened the wrong Input/call'
        assert re.search(r'Tool 1\s*/\s*4', text(details)), 'native Edit is a separate fourth inspectable call'
        session.send(b'\t')
        assert "printf 'bash-one line" in text(frame(session))
        session.send(b'\t')
        session.send(b'\x1b[F')  # the full result may exceed the modal's viewport too
        assert 'bash-one output line 14' in text(frame(session)), 'full result is not reachable beyond the Output preview budget'
        session.send(b']')
        assert 'bash-two output line 1' in text(frame(session)), 'next-call navigation did not select the second Bash'
        session.send(b'[')
        assert 'bash-one output line 1' in text(frame(session))
        session.send(b'\x1b')
        assert 'Tool details' not in text(frame(session))

        offscreen = wheel_until(session, 65, lambda s: not group_rows(s) and any('bash-two output line' in line for line in s['lines']))
        target_row = next(i for i, line in enumerate(offscreen['lines']) if 'bash-two output line' in line)
        target_col = offscreen['lines'][target_row].index('bash-two output line')
        click(session, target_col + 3, target_row)
        folded = wheel_until(session, 64, lambda s: bool(group_rows(s)))
        assert 'click to show more' in folded['lines'][group_rows(folded)[0]]
        assert 'bash-two output line 1' not in text(folded), 'scrolled body single click failed to collapse'

        draft = b'PTY tools retained draft'
        session.send(draft)
        session.wait_for(draft)
        session.send(b'\x18\x0f')
        assert re.search(r'Tool 4\s*/\s*4', text(frame(session)))
        resize(session, 40, 24)
        narrow = frame(session, 40, 24)
        assert 'Tool details' in text(narrow)
        session.send(b'\x1b')
        assert 'PTY tools retained draft' in text(frame(session, 40, 24))
        session.send(b'\x15')  # clear the synthetic draft without submitting it
        result = exit_idle(session)
        result.update({'samePointRoundTrips': 2, 'bodyCollapse': True, 'nativeSelection': True,
                       'groupOutputDetails': True, 'keyboardAllCalls': True, 'resizeAndDraft': True})
        return result
    finally:
        session.close()


def inline():
    session = Session('inline', 'tools-inline-inspector', settings=DEFAULT_SETTINGS)
    try:
        run_flow(session)
        session.send(b'\x0f')
        expanded = frame(session)
        assert b'click to show more' not in session.raw and b'click to show details' not in session.raw, 'inline falsely advertises mouse support'
        draft = b'Inline tools retained draft'
        session.send(draft)
        session.wait_for(draft)
        session.send(b'\x18\x0f')
        assert re.search(r'Tool 4\s*/\s*4', text(frame(session)))
        session.send(b'[')  # MCP
        assert 'Demo MCP note 1' in text(frame(session))
        session.send(b'[')  # second Bash
        assert 'bash-two output line 1' in text(frame(session))
        session.send(b'[')  # first Bash
        assert 'bash-one output line 1' in text(frame(session))
        session.send(b'\t')
        assert "printf 'bash-one line" in text(frame(session))
        resize(session, 40, 24)
        assert 'Tool details' in text(frame(session, 40, 24))
        session.send(b'\x1b')
        assert 'Inline tools retained draft' in text(frame(session, 40, 24))
        session.send(b'\x15')
        result = exit_idle(session)
        result.update({'honestKeyHints': True, 'keyboardAllCalls': True, 'resizeAndDraft': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptyToolsAcceptance': [fullscreen(), inline()]}, indent=2))
