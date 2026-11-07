#!/usr/bin/env python3
"""Above-editor progress acceptance through the actual offline CLI/PTY."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location('pty_subagents_smoke', Path(__file__).with_name('pty-subagents-smoke.py'))
assert spec and spec.loader
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
helpers.helper.OUT = helpers.helper.ROOT / '.cache' / 'subagent-progress' / 'pty'
Session = helpers.Session


def frame(session, columns=110, rows=38):
    helpers.settle(session)
    decoded = subprocess.run([helpers.helper.NODE, str(helpers.helper.ROOT / 'scripts/ansi-screen.ts'),
                              str(columns), str(rows)], input=bytes(session.raw),
                             capture_output=True, check=True, timeout=5)
    return json.loads(decoded.stdout)


def wait_frame(session, predicate, columns=110, rows=38, timeout=6):
    deadline = time.monotonic() + timeout
    latest = None
    while time.monotonic() < deadline:
        latest = frame(session, columns, rows)
        if predicate(latest):
            return latest
        assert not session.poll_exit(), session.tail()
    raise AssertionError('progress screen timed out:\n' + ('\n'.join(latest['lines']) if latest else 'none'))


def widget_frame(session):
    screen = wait_frame(session, lambda value: any('● Agents' in line for line in value['lines'])
                        and any('❯ PTY progress draft' in line for line in value['lines']))
    lines = screen['lines']
    header = next(y for y, line in enumerate(lines) if '● Agents' in line)
    prompt = next(y for y, line in enumerate(lines) if '❯ PTY progress draft' in line)
    assert 0 <= header < prompt and prompt - header <= 9, '\n'.join(lines)
    agents = [(y, line) for y, line in enumerate(lines)
              if header < y < prompt and 'Explore repository' in line]
    assert agents and ('├─' in agents[0][1] or '└─' in agents[0][1]), '\n'.join(lines)
    return screen, header, prompt, agents[0]


def run(mode):
    session = Session(mode, 'subagent-progress', 'subagent')
    try:
        # Styling splits the bullet and title in the raw ANSI stream; the
        # visible “● Agents” identity is asserted through decoded cells below.
        session.wait_for(b'Agents')
        session.wait_for(b'ready')
        helpers.resize(session)
        session.send(b'PTY progress draft')
        screen, header, prompt, agent = widget_frame(session)
        wait_frame(session, lambda value: any('demo (offline)/deepseek-demo' in line and ' · ready' in line
                                             for line in value['lines']))
        # Inspect the actual decoded cells' visible glyph, not raw ANSI bytes.
        # No backend event is needed: the root is ready but child work animates.
        frames = set()
        for _ in range(5):
            _, _, _, current = widget_frame(session)
            prefix = current[1].split('Explore repository', 1)[0].rstrip()
            frames.add(prefix[-1])
            if len(frames) >= 2:
                break
            session.read(0.12)
        assert len(frames) >= 2 and frames <= {'·', '✻', '✶', '✳'}, 'child progress did not reuse the Working animation: ' + repr(frames)
        screen, header, prompt, agent = widget_frame(session)
        opened = len(session.raw)
        if mode == 'fullscreen':
            # Unlike the earlier transcript affordance, this is the real
            # pinned progress row immediately above the main Editor.
            row, line = agent
            helpers.click(session, line.find('Explore repository') + 2, row)
        else:
            # Inline leaves the mouse to terminal scrollback; the unchanged
            # shared Agents shortcut is the keyboard path for the same data.
            session.send(b'\x18\x01')
            session.wait_for(b'Agents', opened)
            session.send(b'\r')
        session.wait_for(b'I mapped the transcript projection', opened)
        session.send(b'\x1b')
        if mode == 'inline':
            wait_frame(session, helpers.agents_overlay_visible)
            session.send(b'\x1b')
        wait_frame(session, lambda value: 'I mapped the transcript projection' not in '\n'.join(value['lines'])
                   and '❯ PTY progress draft' in '\n'.join(value['lines']))
        widget_frame(session)

        helpers.resize(session, 60, 24)
        small = wait_frame(session, lambda value: 'PTY progress draft' in '\n'.join(value['lines']), 60, 24)
        assert '● Agents' in '\n'.join(small['lines']), '\n'.join(small['lines'])
        helpers.resize(session)
        widget_frame(session)

        # The widget header can still open the complete native tree/list.
        if mode == 'fullscreen':
            screen, header, prompt, agent = widget_frame(session)
            helpers.click(session, screen['lines'][header].find('Agents') + 2, header)
            wait_frame(session, helpers.agents_overlay_visible)
            session.send(b'\x1b')
            widget_frame(session)

        # Root draft clear/exit stays root-local; no automatic child stop.
        # Use the visible idle frame and the exact two-key CC sequence instead
        # of racing a third write against a PTY that has already closed.
        wait_frame(session, lambda value: any('demo (offline)/deepseek-demo' in line and ' · ready' in line
                                             for line in value['lines']))
        session.send(b'\x03')
        helpers.settle(session)
        assert not session.poll_exit(), 'clearing the retained draft must not exit'
        session.send(b'\x03')
        result = session.finish(restore_offset=opened)
        result.update({'progressAboveEditor': True, 'piTreeStyle': True,
                       'sharedWorkingAnimation': True, 'rootRemainsReady': True,
                       'entry': 'progress row mouse click' if mode == 'fullscreen' else 'shared keybinding',
                       'nativeChildTranscript': True, 'returnToDraft': True,
                       'compactResize': True, 'headerListClick': mode == 'fullscreen'})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptySubagentProgressAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
