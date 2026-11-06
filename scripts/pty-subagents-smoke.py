#!/usr/bin/env python3
"""Offline subagent TUI acceptance through the real CLI/PTY and xterm cells."""
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

sys.dont_write_bytecode = True
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location('pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Session = helper.Session


def settle(session, duration=0.3):
    quiet = 0
    while quiet < 3 and duration > 0:
        before = len(session.raw)
        session.read(0.05)
        quiet = quiet + 1 if before == len(session.raw) else 0
        duration -= 0.05


def resize(session, columns=110, rows=38):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ,
                struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)
    settle(session)


def frame(session, columns=110, rows=38):
    settle(session)
    decoded = subprocess.run([helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'),
                              str(columns), str(rows)], input=bytes(session.raw),
                             capture_output=True, check=True, timeout=5)
    return json.loads(decoded.stdout)


def click(session, x, y):
    session.send(f'\x1b[<0;{x + 1};{y + 1}M'.encode())
    settle(session)
    session.send(f'\x1b[<0;{x + 1};{y + 1}m'.encode())
    settle(session)


def wait_screen(session, predicate, timeout=5):
    deadline = timeout
    latest = None
    while deadline > 0:
        latest = frame(session)
        if predicate(latest):
            return latest
        deadline -= 0.3
    raise AssertionError('screen predicate timed out:\n' + ('\n'.join(latest['lines']) if latest else 'none'))


def agents_overlay_visible(screen):
    # The persistent Pi-style widget is “● Agents · …”; a bare title belongs
    # to the temporary Agents overlay, even when background edges show through.
    return any(re.search(r'(?<!● )Agents ·', line) for line in screen['lines'])


def click_text(session, marker):
    screen = wait_screen(session, lambda value: any(marker in line for line in value['lines']))
    matches = [(y, line.find(marker)) for y, line in enumerate(screen['lines']) if marker in line]
    assert matches, '\n'.join(screen['lines'])
    y, x = matches[0]
    click(session, x + 1, y)


def run(mode):
    session = Session(mode, 'subagents', 'subagent')
    try:
        session.wait_for(b'Explore repository')
        session.wait_for(b'ready')
        resize(session)
        session.send(b'PTY retained subagent draft')
        opened = len(session.raw)
        if mode == 'fullscreen':
            screen = wait_screen(session, lambda value: any('● Agents' in line for line in value['lines'])
                                 and 'PTY retained subagent draft' in '\n'.join(value['lines']))
            header = next(index for index, line in enumerate(screen['lines']) if '● Agents' in line)
            matches = [(index, line) for index, line in enumerate(screen['lines'])
                       if index > header and 'Explore repository' in line and 'continuable' in line]
            assert matches, '\n'.join(screen['lines'])
            row, line = matches[0]
            click(session, line.find('Explore repository') + 2, row)
        else:
            session.send(b'\x18\x01')
            session.wait_for(b'Agents', opened)
            session.send(b'\r')
        session.wait_for(b'I mapped the transcript projection', opened)
        session.wait_for(b'[S] stop', opened)

        resize(session, 60, 24)
        session.wait_for(b'I mapped the transcript projection', opened)
        resize(session)

        # Stop the initially running fixture child. Fullscreen clicks the real
        # footer chip; inline uses the shared subagent.interrupt binding.
        if mode == 'fullscreen':
            click_text(session, '[S] stop')
        else:
            session.send(b's')
        # The root notice is behind the modal; the visible native row is the
        # authoritative signal while this surface remains open.
        wait_screen(session, lambda screen: 'stopped' in '\n'.join(screen['lines']))

        # Reply returns to the one main Editor with the exact pre-existing
        # draft. Enter accepts that draft through the fixture native command.
        if mode == 'fullscreen':
            click_text(session, '[R] reply')
        else:
            session.send(b'r')
        session.wait_for(b'Replying to Explore repository', opened)
        session.wait_for(b'PTY retained subagent draft', opened)
        session.send(b'\r')
        session.wait_for(b'Reply accepted for Explore repository (queue)', opened)

        # Reopen the child: the accepted draft and deterministic later answer
        # must be projected from the child log, never inserted into the root.
        follow_opened = len(session.raw)
        session.send(b'\x18\x01')
        session.wait_for(b'Agents', follow_opened)
        session.send(b'\r')
        session.wait_for(b'PTY retained subagent draft', follow_opened)
        session.wait_for(b'Follow-up received', follow_opened)
        session.send(b'\x1b')
        wait_screen(session, agents_overlay_visible)
        session.send(b'\x1b')
        wait_screen(session, lambda screen: not agents_overlay_visible(screen))
        # The target remains until Esc explicitly returns to the root.
        session.wait_for(b'Replying to Explore repository', opened)
        session.send(b'\x1b')
        wait_screen(session, lambda screen: 'Replying to Explore repository' not in '\n'.join(screen['lines']))

        # Wait for the actual idle frame (an older raw 'ready' is not enough).
        deadline = 5.0
        while 'Working' in '\n'.join(frame(session)['lines']) and deadline > 0:
            settle(session)
            deadline -= 0.3
        idle_text = '\n'.join(frame(session)['lines'])
        assert 'ready' in idle_text, 'demo did not return to idle:\n' + idle_text
        # Empty root draft: first Ctrl+C arms, the second exits. A third byte
        # after terminal restore would become an OS SIGINT, not TUI input.
        armed = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'Press the same exit key again to exit', armed)
        session.send(b'\x03')
        result = session.finish(restore_offset=opened)
        result.update({'catalog': True, 'childTranscript': True,
                       'entry': 'progress row mouse' if mode == 'fullscreen' else 'keybinding',
                       'resize': True, 'draftPreserved': True,
                       'nativeInterrupt': True, 'nativeReply': True,
                       'controlInput': 'mouse chips' if mode == 'fullscreen' else 'keybindings',
                       'followupTranscript': True, 'replyTargetExit': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptySubagentAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
