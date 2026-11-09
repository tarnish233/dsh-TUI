#!/usr/bin/env python3
"""Production App PTY with explicit offline native-shaped facts; not native APIs."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native_ui_pty', ROOT / 'scripts/pty-native-ui-batches.py')
assert spec and spec.loader
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.OUT = ROOT / '.cache/presentation-convergence/pty'
base.OUT.mkdir(parents=True, exist_ok=True)


def has(rows, text):
    return any(text in line for line in rows)


def header(rows, name):
    mark = '●' if name == 'Agents' else '⏺'
    return next((i for i, line in enumerate(rows) if line.lstrip().startswith(mark + ' ' + name)), -1)


def docks(rows):
    return all(header(rows, name) >= 0 for name in ['Todos', 'Goal', 'Agents'])


def gaps_match(rows, expected):
    indexes = [header(rows, name) for name in ['Todos', 'Goal', 'Agents']]
    if not all(i >= 0 for i in indexes):
        return False
    gaps = [rows[indexes[1]-1].strip() == '', rows[indexes[2]-1].strip() == '']
    return gaps == [expected, expected]


def assert_gaps(rows, expected):
    assert gaps_match(rows, expected), '\n'.join(rows)


def run(mode):
    s = base.Session(mode, fixture='task-dock-coexist-pty.ts')
    try:
        s.resize(100, 36)
        s.wait(lambda rows: has(rows, 'ready'))
        s.send(b'presentation\r')
        rows = s.wait(lambda rows: docks(rows) and has(rows, 'Activities') and has(rows, '1 tool') and has(rows, '1 update'))
        assert_gaps(rows, True)
        assert not has(rows, 'PTY PRESENTATION NOTICE BODY')
        s.send(b'\x0f')
        s.wait(lambda rows: has(rows, 'PTY PRESENTATION NOTICE BODY'))
        s.send(b'\x0f')
        s.wait(lambda rows: not has(rows, 'PTY PRESENTATION NOTICE BODY') and has(rows, 'Activities'))
        s.send(b'message\r')
        s.wait(lambda rows: has(rows, 'PTY ACTUAL MESSAGE VISIBLE') and has(rows, 'Activities'))

        s.send(b'line one\x0aline two\x0aline three\x0aline four\x0aPRESENTATION DRAFT')
        s.wait(lambda rows: docks(rows) and has(rows, 'PRESENTATION DRAFT'))
        for cols, height in [(80, 16), (40, 18)]:
            s.resize(cols, height)
            rows = s.wait(lambda rows: docks(rows) and has(rows, 'PRESENTATION DRAFT') and gaps_match(rows, False))
            assert_gaps(rows, False)
        s.resize(100, 36)
        rows = s.wait(lambda rows: docks(rows) and has(rows, 'PRESENTATION DRAFT') and gaps_match(rows, True))
        assert_gaps(rows, True)

        # Fullscreen Pi owns SGR mouse dispatch; legacy main-screen uses
        # native scrollback and its existing keyboard navigation instead.
        if mode == 'fullscreen':
            y = header(rows, 'Agents') + 1
            x = rows[y-1].index('Agents') + 2
            s.send(f'\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m'.encode())
        else:
            s.send(b'\x18\x01')
        s.wait(lambda rows: has(rows, '┌─ Agents'))
        s.send(b'\x1b')
        s.wait(lambda rows: not has(rows, '┌─ Agents') and has(rows, 'PRESENTATION DRAFT'))
        s.send(b'\x14')
        s.wait(lambda rows: header(rows, 'Todos') < 0 and header(rows, 'Goal') >= 0 and header(rows, 'Agents') >= 0 and has(rows, 'PRESENTATION DRAFT'))
        s.send(b'\x14')
        s.wait(lambda rows: docks(rows) and has(rows, 'PRESENTATION DRAFT'))
        s.send(b'\x03')
        s.wait(lambda rows: not has(rows, 'PRESENTATION DRAFT') and docks(rows))
        restored_at = len(s.raw)
        s.send(b'/exit\r')
        deadline = time.monotonic() + 8
        while s.status is None:
            s.read()
            assert time.monotonic() < deadline, 'exit hung'
        assert os.waitstatus_to_exitcode(s.status) == 0
        tail = s.raw[restored_at:]
        assert b'\x1b[?2004l' in tail and b'\x1b[?25h' in tail, 'terminal state not restored'
        if mode == 'fullscreen':
            assert b'\x1b[?1049l' in tail
        return {'mode': mode, 'uniformRoomyGaps': True, 'compactDropsAllGaps': True,
                'mixedDisclosure': True, 'genuineMessageVisible': True, 'agentsNavigation': True,
                'dockMouseOffset': mode == 'fullscreen',
                'toggleAndMultiline': True, 'terminalRestored': True,
                'explicitFixtureOnly': True, 'models': False, 'nativeApiTestedHere': False}
    finally:
        s.close()


if __name__ == '__main__':
    print(json.dumps({'presentationConvergence': [run('inline'), run('fullscreen')]}, indent=2))
