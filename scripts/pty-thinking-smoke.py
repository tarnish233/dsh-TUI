#!/usr/bin/env python3
"""Thinking click round trips through the real CLI/PTY, using painted VT cells.

Offline demo only, temporary configuration, no model calls. Tests both preview
policies (0 and 3), clicks the actual hint column twice, then exercises body drag
selection and body click-to-collapse with the title genuinely scrolled away.
Raw repaint substrings are NOT used to infer which row was clicked or whether
old reasoning disappeared: an independent xterm emulator decodes the screen.
"""
import importlib.util
import fcntl
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
spec = importlib.util.spec_from_file_location(
    'pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Session = helper.Session

COLUMNS = 80
ROWS = 32
PROMPT = b'show the reasoning summary flow'
COMPLETION = '完成。Demo'.encode('utf8')
HIDDEN_LINE = 'Demo reasoning: build a deterministic reply'
SETTINGS = {'showThinking': True, 'thinkingPreviewLines': 3}
SUMMARY = re.compile(r'^\s*✻ (?:Thought|Thinking)')


def resize(session):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ,
                struct.pack('HHHH', ROWS, COLUMNS, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)


def run_flow(session):
    session.wait_for(b'ready')
    resize(session)
    session.send(PROMPT)
    session.wait_for(PROMPT)
    session.send(b'\r')
    session.wait_for(COMPLETION, timeout=20)
    session.wait_for(b'Thought for', timeout=5)
    session.wait_for(b'more lines', timeout=5)
    # Completion text arrives before the turn is idle. Do not mistake the
    # startup footer's ready status for completion of this turn.
    session.wait_for(b'ready', offset=len(session.raw), timeout=20)


def settle(session, cap=0.5):
    quiet = 0
    while quiet < 3:
        before = len(session.raw)
        session.read(0.05)
        quiet = quiet + 1 if len(session.raw) == before else 0
        if (cap := cap - 0.05) <= 0:
            break


def screen(session):
    settle(session)
    result = subprocess.run(
        [helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'),
         str(COLUMNS), str(ROWS)], input=bytes(session.raw),
        capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)


def summary_rows(frame):
    return [row for row, line in enumerate(frame['lines']) if SUMMARY.match(line)]


def scroll_to_top(session):
    for _ in range(24):
        session.send(b'\x1b[<64;40;5M')
        session.read(0.03)
    settle(session)


def click(session, col, row):
    # Input coordinates are zero-based VT cells, encoded as 1-based SGR.
    session.send(f'\x1b[<0;{col + 1};{row + 1}M'.encode('ascii'))
    settle(session)
    session.send(f'\x1b[<0;{col + 1};{row + 1}m'.encode('ascii'))
    settle(session)


def fullscreen_click_round_trip(preview):
    session = Session('fullscreen', f'thinking-preview-{preview}',
                      settings={**SETTINGS, 'thinkingPreviewLines': preview})
    try:
        run_flow(session)
        scroll_to_top(session)
        frame = screen(session)
        rows = summary_rows(frame)
        assert len(rows) == 1, 'collapsed thinking summary must be painted'
        row = rows[0]
        col = frame['lines'][row].index('click to show more') + 5
        assert HIDDEN_LINE not in '\n'.join(frame['lines']), \
            'the collapsed preview must hide the reasoning head'

        # Test real hint coordinates, not a lucky fixed click at column 4.
        for _ in range(2):
            click(session, col, row)
            expanded = screen(session)
            assert summary_rows(expanded) == [row], \
                'expanded title must stay on the clicked row'
            assert 'click to collapse' in expanded['lines'][row]
            assert HIDDEN_LINE in '\n'.join(expanded['lines'])
            follow_rows = [i for i, line in enumerate(expanded['lines'])
                           if 'Back to bottom' in line]
            assert all(i > row for i in follow_rows), \
                'the follow button must not cover the thinking title'
            click(session, col, row)
            collapsed = screen(session)
            assert summary_rows(collapsed) == [row]
            assert 'more line' in collapsed['lines'][row]
            assert 'click to show more' in collapsed['lines'][row]
            assert HIDDEN_LINE not in '\n'.join(collapsed['lines']), \
                'the second same-point click must truly collapse the body'

        click(session, col, row)
        expanded = screen(session)
        # The body is between the heading and the next empty separator. Keep
        # its wrap lines so it can be identified after scrolling the title out.
        body_rows = []
        for index in range(row + 1, len(expanded['lines'])):
            if expanded['lines'][index].strip() == '':
                break
            body_rows.append(index)
        assert len(body_rows) > preview
        body_lines = {expanded['lines'][i].strip() for i in body_rows}

        # Body press is unclaimed, so native selection/drag remains functional.
        drag_row = body_rows[0]
        session.send(f'\x1b[<0;9;{drag_row + 1}M'.encode('ascii'))
        settle(session)
        session.send(f'\x1b[<32;25;{drag_row + 1}M'.encode('ascii'))
        settle(session)
        session.send(f'\x1b[<0;25;{drag_row + 1}m'.encode('ascii'))
        selected = screen(session)
        assert HIDDEN_LINE in '\n'.join(selected['lines']), \
            'dragging the thinking text must not collapse it'
        assert 'click to collapse' in selected['lines'][row]
        assert any(selected['attributes'][drag_row][i] !=
                   expanded['attributes'][drag_row][i] for i in range(8, 25)), \
            'the dragged body cells must carry native selection highlighting'

        # Read further into the thought: title no longer visible. Unlike the
        # old implementation, a completed body click can still close the run.
        offscreen_body_row = None
        for _ in range(20):
            session.send(b'\x1b[<65;40;5M')
            frame = screen(session)
            candidates = [i for i, line in enumerate(frame['lines'])
                          if line.strip() in body_lines]
            if not summary_rows(frame) and candidates:
                offscreen_body_row = candidates[0]
                break
        assert offscreen_body_row is not None, \
            'the test must actually scroll the heading out while body is visible'
        click(session, 5, offscreen_body_row)
        scroll_to_top(session)
        collapsed = screen(session)
        rows = summary_rows(collapsed)
        assert len(rows) == 1
        assert 'more line' in collapsed['lines'][rows[0]]
        assert 'click to show more' in collapsed['lines'][rows[0]]
        assert HIDDEN_LINE not in '\n'.join(collapsed['lines']), \
            'single clicking the off-title body must collapse the thinking run'

        exit_offset = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', exit_offset)
        session.send(b'\x03')
        return session.finish(restore_offset=exit_offset)
    finally:
        session.close()


def inline_hint_degrades():
    session = Session('inline', 'thinking-inline', settings=SETTINGS)
    try:
        run_flow(session)
        assert b'click to show more' not in bytes(session.raw), \
            'inline mode must not advertise mouse support'
        exit_offset = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', exit_offset)
        session.send(b'\x03')
        return session.finish(restore_offset=exit_offset)
    finally:
        session.close()


def main():
    results = [fullscreen_click_round_trip(0),
               fullscreen_click_round_trip(3), inline_hint_degrades()]
    for result in results:
        print(f"thinking PTY {result['mode']} {result['scenario']}: "
              f"exit={result['exit']} restored={result['terminalRestored']} "
              f"{result['durationSeconds']}s {result['bytes']}B")


if __name__ == '__main__':
    main()
