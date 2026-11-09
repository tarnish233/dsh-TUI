#!/usr/bin/env python3
"""Public dsh-tui --demo tasks PTY acceptance, entirely offline/temporary."""
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
base.OUT = ROOT / '.cache/demo-tasks/pty'
base.OUT.mkdir(parents=True, exist_ok=True)


def header(rows, label):
    mark = '●' if label == 'Agents' else '⏺'
    return next((line for line in rows if line.lstrip().startswith(mark + ' ' + label)), None)


def ready(rows):
    return any('deepseek-demo' in line and 'ready' in line for line in rows)


def all_docks(rows):
    return all(header(rows, label) is not None for label in ['Todos', 'Goal', 'Agents'])


def assert_order(rows):
    indexes = [next(i for i, line in enumerate(rows) if line == header(rows, label)) for label in ['Todos', 'Goal', 'Agents']]
    editor = next((i for i, line in enumerate(rows) if line.lstrip().startswith('❯')), -1)
    assert editor >= 0, 'Editor row missing in frame:\n' + '\n'.join(rows)
    assert indexes[0] < indexes[1] < indexes[2] < editor, '\n'.join(rows)


def run(mode):
    s = base.Session(mode, demo_scenario='tasks')
    try:
        s.resize(100, 36)
        rows = s.wait(lambda rows: ready(rows) and all_docks(rows) and any('Activities' in line for line in rows) and any('DEMO CHILD MESSAGE' in line for line in rows))
        assert_order(rows)
        assert any('1 tool' in line and '1 update' in line for line in rows), '\n'.join(rows)
        assert not any('DEMO STATUS NOTICE BODY' in line for line in rows), '\n'.join(rows)
        s.send(b'\x0f')
        s.wait(lambda rows: any('DEMO STATUS NOTICE BODY' in line for line in rows) and any('DEMO CHILD MESSAGE' in line for line in rows))
        s.send(b'\x0f')
        s.wait(lambda rows: not any('DEMO STATUS NOTICE BODY' in line for line in rows) and any('DEMO CHILD MESSAGE' in line for line in rows))
        before = header(rows, 'Todos')
        s.send(b'tasks next\r')
        rows = s.wait(lambda rows: ready(rows) and all_docks(rows) and header(rows, 'Todos') != before)
        assert_order(rows)

        # Long ordinary demo transcript, not a private alternate renderer.
        s.send(b'tasks history\r')
        s.wait(lambda rows: ready(rows) and all_docks(rows))
        s.send(b'line one\x0aline two\x0aline three\x0aline four\x0aTASKS-DEMO-DRAFT')
        s.wait(lambda rows: all_docks(rows) and any('TASKS-DEMO-DRAFT' in line for line in rows))
        for cols, height in [(80, 16), (40, 18), (100, 28)]:
            s.resize(cols, height)
            rows = s.wait(lambda rows: all_docks(rows) and any('TASKS-DEMO-DRAFT' in line for line in rows))
            assert_order(rows)
        s.send(b'\x14')
        s.wait(lambda rows: header(rows, 'Todos') is None and header(rows, 'Goal') is not None and header(rows, 'Agents') is not None and any('TASKS-DEMO-DRAFT' in line for line in rows))
        s.send(b'\x14')
        s.wait(lambda rows: all_docks(rows) and any('TASKS-DEMO-DRAFT' in line for line in rows))

        # Same live editor remains mounted behind both existing overlays.
        s.send(b'\x18\x01')
        s.wait(lambda rows: any('┌─ Agents' in line for line in rows))
        s.send(b'\x1b')
        s.wait(lambda rows: not any('┌─ Agents' in line for line in rows) and any('TASKS-DEMO-DRAFT' in line for line in rows))
        s.send(b'\x03')
        s.wait(lambda rows: not any('TASKS-DEMO-DRAFT' in line for line in rows) and all_docks(rows))
        s.send(b'/settings\r')
        s.wait(lambda rows: any('┌─ Settings' in line for line in rows))
        assert b'\x1b[48;2;17;17;19m' not in s.raw, 'private modal black plate returned'
        s.send(b'\x1b')
        s.wait(lambda rows: not any('┌─ Settings' in line for line in rows) and all_docks(rows))

        s.send(b'tasks done\r')
        s.wait(lambda rows: ready(rows) and header(rows, 'Todos') is None and header(rows, 'Agents') is None and header(rows, 'Goal') is not None)
        s.send(b'tasks clear\r')
        s.wait(lambda rows: ready(rows) and all(header(rows, label) is None for label in ['Todos', 'Goal', 'Agents']))
        s.send(b'tasks\r')
        s.wait(lambda rows: ready(rows) and all_docks(rows))
        assert not (s.directory / 'profiles').exists(), 'demo touched a native DSH profile'

        restored_at = len(s.raw)
        s.send(b'/exit\r')
        deadline = time.monotonic() + 8
        while s.status is None:
            s.read()
            assert time.monotonic() < deadline, 'demo exit hung'
        assert os.waitstatus_to_exitcode(s.status) == 0
        tail = s.raw[restored_at:]
        assert b'\x1b[?2004l' in tail and b'\x1b[?25h' in tail, 'terminal state not restored'
        if mode == 'fullscreen':
            assert b'\x1b[?1049l' in tail
        return {'mode': mode, 'publicCliEntry': True, 'allThreeDocks': True,
                'initialMixedActivity': True, 'independentDemoChildMessage': True,
                'nextDoneClearRestart': True, 'historyAndCompactResize': True,
                'toggleAndExistingOverlays': True, 'multilineEditorPreserved': True,
                'terminalRestored': True, 'nativeCommandWasUnusable': True,
                'models': False, 'explicitOfflineDemo': True}
    finally:
        s.close()


if __name__ == '__main__':
    print(json.dumps({'demoTasks': [run('inline'), run('fullscreen')]}, indent=2))
