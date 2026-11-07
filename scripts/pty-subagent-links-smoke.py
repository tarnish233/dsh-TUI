#!/usr/bin/env python3
"""Name-only internal navigation, text selection and copy through offline CLI/PTY."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

sys.dont_write_bytecode = True
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location('pty_progress_helpers', Path(__file__).with_name('pty-subagent-progress-smoke.py'))
assert spec and spec.loader
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)
helpers = progress.helpers
helpers.helper.OUT = helpers.helper.ROOT / '.cache' / 'subagent-links' / 'pty'
Session = helpers.Session


def frame(session, columns=110, rows=38):
    helpers.settle(session)
    result = subprocess.run([helpers.helper.NODE, str(helpers.helper.ROOT / 'scripts/ansi-screen.ts'),
                             str(columns), str(rows), '--cells'], input=bytes(session.raw),
                            capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)


def wait_frame(session, predicate, columns=110, rows=38, timeout=6):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = frame(session, columns, rows)
        if predicate(latest):
            return latest
        assert not session.poll_exit(), session.tail()
    raise AssertionError('link screen timed out:\n' + ('\n'.join(latest['lines']) if latest else 'none'))


def columns_for(screen, row, text):
    """Use emulator cell widths, never string length or a private Unicode algorithm."""
    plain = ''
    spans = []
    for column, cell in enumerate(screen['cells'][row]):
        chars, width = cell[:2]
        if width == 0:
            continue
        chars = chars or ' '
        start = len(plain)
        plain += chars
        spans.append((start, len(plain), column, column + width))
    start = plain.find(text)
    assert start >= 0, (text, plain)
    end = start + len(text)
    start_column = next(span[2] for span in spans if span[0] <= start < span[1])
    end_column = next(span[3] for span in spans if span[0] < end <= span[1])
    return start_column, end_column


def widget(session, columns=110, rows=38):
    screen = wait_frame(session, lambda value: any('● Agents' in line for line in value['lines'])
                        and any('❯ PTY link draft' in line for line in value['lines']), columns, rows)
    header = next(y for y, line in enumerate(screen['lines']) if '● Agents' in line)
    prompt = next(y for y, line in enumerate(screen['lines']) if '❯ PTY link draft' in line)
    agent = next(y for y, line in enumerate(screen['lines'])
                 if header < y < prompt and 'Explore repository' in line)
    return screen, header, prompt, agent


def click(session, x, y):
    helpers.click(session, x, y)


def copy_status(session, screen, row):
    start, end = columns_for(screen, row, 'running')
    name_start, _ = columns_for(screen, row, 'Explore repository')
    session.send(f'\x1b[<35;{name_start + 2};{row + 1}M'.encode())
    helpers.settle(session)
    offset = len(session.raw)
    session.send(f'\x1b[<0;{start + 1};{row + 1}M'.encode())
    helpers.settle(session)
    session.send(f'\x1b[<32;{end};{row + 1}M'.encode())
    helpers.settle(session)
    session.send(f'\x1b[<0;{end};{row + 1}m'.encode())
    deadline = time.monotonic() + 5
    packets = []
    while time.monotonic() < deadline:
        session.read(0.05)
        packets = re.findall(rb'\x1b\]52;c;([A-Za-z0-9+/=]+)\x07', bytes(session.raw[offset:]))
        if packets:
            break
    assert packets, 'native status selection did not emit a controlled copy packet'
    assert base64.b64decode(packets[-1]).decode().strip() == 'running'
    # OSC52 is captured in this private PTY, never forwarded to a real terminal.
    widget(session)


def run(mode):
    session = Session(mode, 'subagent-links', 'subagent-many')
    negative_clicks = 0
    try:
        session.wait_for(b'Agents')
        helpers.resize(session)
        wait_frame(session, lambda value: any('demo (offline)/deepseek-demo' in line and ' · ready' in line
                                             for line in value['lines']))
        session.send(b'PTY link draft')
        screen, header, prompt, row = widget(session)
        name_start, name_end = columns_for(screen, row, 'Explore repository')
        assert all(cell[4] and cell[5] for cell in screen['cells'][row][name_start:name_end] if cell[1] != 0), 'name is bold and underlined'
        assert not screen['cells'][row][name_end][5], 'the name gap is not underlined'
        external = next((y for y, line in enumerate(screen['lines'])
                         if header < y < prompt and 'External research' in line), None)
        assert external is None, 'external history must not consume active progress rows'
        assert not any('Review changes' in line or 'Verify build' in line
                       for line in screen['lines'][header + 1:prompt]), 'settled rows must leave active progress'

        opened = len(session.raw)
        if mode == 'fullscreen':
            status, _ = columns_for(screen, row, 'running')
            tokens, _ = columns_for(screen, row, 'tok')
            title_start, title_end = columns_for(screen, header, 'Agents')
            count, _ = columns_for(screen, header, 'children')
            hint, _ = columns_for(screen, header, 'Ctrl+X')
            activity = next(y for y, line in enumerate(screen['lines'])
                            if row < y < prompt and 'reading src/state/transcript.ts' in line)
            activity_start, _ = columns_for(screen, activity, 'reading src/state/transcript.ts')
            points = [(0, row), (name_start - 1, row), (name_end, row),
                      (status + 1, row), (tokens + 1, row), (109, row),
                      (activity_start + 2, activity), (0, header),
                      (title_start - 1, header), (title_end, header),
                      (count + 1, header), (hint + 1, header)]
            for x, y in points:
                click(session, x, y)
                screen, _, _, _ = widget(session)
                assert not helpers.agents_overlay_visible(screen), 'a non-link cell opened Agents'
                assert 'I mapped the transcript projection' not in '\n'.join(screen['lines'])
                negative_clicks += 1
            copy_status(session, screen, row)
            screen, header, prompt, row = widget(session)
            name_start, _ = columns_for(screen, row, 'Explore repository')
            click(session, name_start + 1, row)
        else:
            session.send(b'\x18\x01')
            wait_frame(session, helpers.agents_overlay_visible)
            session.send(b'\r')
        session.wait_for(b'I mapped the transcript projection', opened)
        session.send(b'\x1b')
        if mode == 'inline':
            wait_frame(session, helpers.agents_overlay_visible)
            session.send(b'\x1b')
        screen, header, prompt, row = widget(session)

        # The retired native catalog remains reachable through the UI-owned
        # /agent command. Stash/restore uses the same root Editor; no second
        # composer and no real clipboard is involved.
        session.send(b'\x13')
        wait_frame(session, lambda value: not any('❯ PTY link draft' in line for line in value['lines']))
        session.send(b'/agent\r')
        history = wait_frame(session, lambda value: helpers.agents_overlay_visible(value)
                             and any('External research' in line for line in value['lines']))
        assert 'Review changes' in '\n'.join(history['lines'])
        external_row = next(y for y, line in enumerate(history['lines']) if 'External research' in line)
        external_start, external_end = columns_for(history, external_row, 'External research')
        assert not any(cell[5] for cell in history['cells'][external_row][external_start:external_end]), 'external history is not a fake name link'
        if mode == 'fullscreen':
            click(session, external_start + 1, external_row)
            history = wait_frame(session, helpers.agents_overlay_visible)
            assert 'I mapped the transcript projection' not in '\n'.join(history['lines'])
            negative_clicks += 1
        session.send(b'\x1b')
        wait_frame(session, lambda value: not helpers.agents_overlay_visible(value))
        session.send(b'\x13')
        screen, header, prompt, row = widget(session)

        if mode == 'fullscreen':
            title_start, _ = columns_for(screen, header, 'Agents')
            click(session, title_start + 1, header)
            wait_frame(session, helpers.agents_overlay_visible)
            session.send(b'\x1b'); widget(session)
            helpers.resize(session, 110, 18)
            small, _, _, _ = widget(session, 110, 18)
            overflow = next(y for y, line in enumerate(small['lines']) if re.search(r'\+[0-9]+ more', line))
            label = re.search(r'\+[0-9]+ more', small['lines'][overflow]).group()
            more_start, more_end = columns_for(small, overflow, label)
            for x in [0, more_start - 1, more_end]:
                click(session, x, overflow)
                latest, _, _, _ = widget(session, 110, 18)
                assert not helpers.agents_overlay_visible(latest), 'overflow padding/guide opened Agents'
                negative_clicks += 1
            click(session, more_start + 1, overflow)
            wait_frame(session, helpers.agents_overlay_visible, 110, 18)
            session.send(b'\x1b')
            helpers.resize(session); widget(session)
        else:
            helpers.resize(session, 60, 24); widget(session, 60, 24)
            helpers.resize(session); widget(session)

        session.send(b'\x03'); helpers.settle(session)
        assert not session.poll_exit(), 'clearing a retained draft must not exit'
        session.send(b'\x03')
        result = session.finish(restore_offset=opened)
        result.update({'nameLinkStyle': True, 'entry': 'agent-name link' if mode == 'fullscreen' else 'shared keybinding',
                       'nameOnlyNavigation': mode == 'fullscreen', 'nonLinkClicks': negative_clicks,
                       'nativeSelectionCopy': mode == 'fullscreen', 'headerOverflowTextOnly': mode == 'fullscreen',
                       'externalNotLink': True, 'settledRetiredFromProgress': True,
                       'agentHistoryCommand': True, 'draftPreserved': True, 'resize': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptySubagentLinksAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
