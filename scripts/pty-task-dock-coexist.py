#!/usr/bin/env python3
"""Independent PTY QA for coexistence; explicit offline projections, no models."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native_ui_pty', ROOT / 'scripts/pty-native-ui-batches.py')
assert spec and spec.loader
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.OUT = ROOT / '.cache/task-dock-coexist/pty'
base.OUT.mkdir(parents=True, exist_ok=True)


def has(rows, text):
    return any(text in line for line in rows)


def assert_order(rows):
    todo = next(i for i, line in enumerate(rows) if 'PTY COEXIST TODO' in line)
    goal = next(i for i, line in enumerate(rows) if 'Goal' in line)
    agents = next(i for i, line in enumerate(rows) if 'Agents' in line)
    editor = next(i for i, line in enumerate(rows) if 'DRAFT-TAIL' in line)
    assert 0 <= todo < goal < agents < editor, '\n'.join(rows)
    assert sum('PTY COEXIST TODO' in line for line in rows) == 1, '\n'.join(rows)


def run(mode):
    s = base.Session(mode, fixture='task-dock-coexist-pty.ts')
    try:
        s.wait(lambda rows: has(rows, 'ready'))
        s.send(b'history\r')
        s.wait(lambda rows: has(rows, 'PTY COEXIST TODO'))
        # Real readline newlines (Ctrl+J), not a collapsed bracketed paste.
        s.send(b'line one\x0aline two\x0aline three\x0aline four\x0aDRAFT-TAIL')
        s.wait(lambda rows: has(rows, 'DRAFT-TAIL'))
        s.resize(80, 16)
        before = s.wait(lambda rows: has(rows, 'DRAFT-TAIL') and has(rows, 'PTY COEXIST TODO'))
        assert not has(before, 'Agents')

        os.kill(s.pid, signal.SIGUSR2)  # Actual projection arrival while draft stays untouched.
        compact = s.wait(lambda rows: has(rows, 'Todos') and has(rows, 'PTY COEXIST TODO') and has(rows, 'Agents') and has(rows, 'DRAFT-TAIL'))
        assert next(line for line in compact if 'PTY COEXIST TODO' in line).find('Todos') >= 0, '\n'.join(compact)
        assert next(i for i, line in enumerate(compact) if 'PTY COEXIST TODO' in line) < next(i for i, line in enumerate(compact) if 'Agents' in line)

        os.kill(s.pid, signal.SIGUSR2)  # Settled catalog must release its reserved row.
        settled = s.wait(lambda rows: not has(rows, 'Agents') and has(rows, 'PTY COEXIST TODO') and has(rows, 'DRAFT-TAIL'))
        todo_header = next(i for i, line in enumerate(settled) if 'Todos' in line)
        todo_item = next(i for i, line in enumerate(settled) if 'PTY COEXIST TODO' in line)
        assert todo_header < todo_item, 'settled child left a phantom compact-row reservation:\n' + '\n'.join(settled)

        os.kill(s.pid, signal.SIGUSR2)  # Now native Goal + active child + Todo coexist.
        all_three = s.wait(lambda rows: has(rows, 'PTY COEXIST TODO') and has(rows, 'Goal') and has(rows, 'Agents') and has(rows, 'DRAFT-TAIL'))
        assert_order(all_three)
        s.send(b'\x14')
        s.wait(lambda rows: not has(rows, 'PTY COEXIST TODO') and has(rows, 'Goal') and has(rows, 'Agents') and has(rows, 'DRAFT-TAIL'))
        s.send(b'\x14')
        assert_order(s.wait(lambda rows: has(rows, 'PTY COEXIST TODO') and has(rows, 'Goal') and has(rows, 'Agents') and has(rows, 'DRAFT-TAIL')))

        s.resize(40, 18)
        assert_order(s.wait(lambda rows: has(rows, 'PTY COEXIST TODO') and has(rows, 'Goal') and has(rows, 'Agents') and has(rows, 'DRAFT-TAIL')))
        s.resize(100, 28)
        expanded = s.wait(lambda rows: has(rows, 'PTY COEXIST TODO') and has(rows, 'PTY CHILD LABEL') and has(rows, 'PTY GOAL OBJECTIVE') and has(rows, 'DRAFT-TAIL'))
        assert_order(expanded)
        assert has(expanded, 'PTY native current activity'), '\n'.join(expanded)
        assert has(expanded, '+1 more'), '\n'.join(expanded)

        os.kill(s.pid, signal.SIGUSR2)
        s.wait(lambda rows: not has(rows, 'Agents') and has(rows, 'PTY COEXIST TODO') and has(rows, 'Goal') and has(rows, 'DRAFT-TAIL'))
        s.send(b'\x03')  # CC clears the one nonempty multiline draft before /exit.
        s.wait(lambda rows: not has(rows, 'DRAFT-TAIL') and has(rows, 'PTY COEXIST TODO'))
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
        return {'mode': mode, 'todoSurvivesChildStart': True, 'settlementReleasesSlot': True,
                'allThreeCompact': True, 'expandedDetails': True, 'toggleAndResize': True,
                'multilineDraftPreserved': True, 'terminalRestored': True,
                'models': False, 'nativeApiTestedHere': False, 'explicitFixtureOnly': True}
    finally:
        s.close()


if __name__ == '__main__':
    print(json.dumps({'ptyTaskDockCoexistence': [run('inline'), run('fullscreen')]}, indent=2))
