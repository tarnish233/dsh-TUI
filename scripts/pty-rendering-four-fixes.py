#!/usr/bin/env python3
"""Independent production-renderer PTY check of hover and native header seams."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('native_ui_pty', ROOT / 'scripts/pty-native-ui-batches.py')
assert spec and spec.loader
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.OUT = ROOT / '.cache/rendering-four-fixes/pty'
base.OUT.mkdir(parents=True, exist_ok=True)


def evidence(session):
    session.frame()  # drain through a complete DEC2026 frame, not half a write
    out = subprocess.run([base.NODE, str(ROOT / 'scripts/ansi-screen.ts'), str(session.cols), str(session.rows), '--cells'],
                         input=bytes(session.raw), capture_output=True, check=True, timeout=8)
    return json.loads(out.stdout)


def positions(frame):
    out = []
    for y, line in enumerate(frame['lines']):
        for text in ['click to expand', 'click to show more']:
            x = line.find(text)
            if x >= 0:
                out.append({'x': x, 'y': y, 'text': text})
    return out


def color(frame, point):
    return frame['cells'][point['y']][point['x']][2:4]


def wait_evidence(session, predicate, timeout=8):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = evidence(session)
        if predicate(last):
            return last
        assert session.status is None, 'unexpected PTY exit'
    raise AssertionError('Hover evidence timed out:\n' + '\n'.join(last['lines'] if last else []))


def move(session, point):
    session.send(f"\x1b[<35;{point['x']+2};{point['y']+1}M".encode())


def run(mode):
    session = base.Session(mode, fixture='rendering-four-pty.ts')
    try:
        session.resize(110, 50)
        frame = wait_evidence(session, lambda f: any('Read Image /fixture/image.png' in line for line in f['lines']) and any('ready' in line for line in f['lines']))
        assert not any('Read ImageRead image' in line for line in frame['lines'])
        if mode == 'fullscreen':
            points = positions(frame)
            assert len(points) >= 5, '\n'.join(frame['lines'])
            tool_points = [p for p in points if p['text'] == 'click to expand']
            first, second = tool_points[:2]
            thought = next(p for p in points if p['text'] == 'click to show more')
            group = points[-1]
            neutral = [color(frame, p) for p in points]
            session.send(b'PTY kept hover draft')
            session.wait(lambda lines: any('PTY kept hover draft' in line for line in lines))
            for current in [first, second, thought, group]:
                move(session, current)
                frame = wait_evidence(session, lambda f: all(color(f, p) != neutral[i] if p == current else color(f, p) == neutral[i]
                                                            for i, p in enumerate(points)))
            editor_y = next(i for i, line in enumerate(frame['lines']) if 'PTY kept hover draft' in line)
            move(session, {'x': 10, 'y': editor_y})
            frame = wait_evidence(session, lambda f: all(color(f, p) == neutral[i] for i, p in enumerate(points)))
            assert any('PTY kept hover draft' in line for line in frame['lines'])
            move(session, group)
            wait_evidence(session, lambda f: color(f, group) != neutral[points.index(group)])
            session.send(b'\x1b[O')
            wait_evidence(session, lambda f: all(color(f, p) == neutral[i] for i, p in enumerate(points)))
            session.send(b'\x1b[I')
            move(session, group)
            wait_evidence(session, lambda f: color(f, group) != neutral[points.index(group)])
            move(session, {'x': 10, 'y': editor_y})
            wait_evidence(session, lambda f: all(color(f, p) == neutral[i] for i, p in enumerate(points)))
            session.send(b'\x03')
            session.wait(lambda lines: not any('PTY kept hover draft' in line for line in lines))
        restored = len(session.raw)
        session.send(b'/exit\r')
        deadline = time.monotonic() + 8
        while session.status is None:
            session.read()
            assert time.monotonic() < deadline, 'exit hung'
        import os
        assert os.waitstatus_to_exitcode(session.status) == 0
        tail = session.raw[restored:]
        assert b'\x1b[?2004l' in tail and b'\x1b[?25h' in tail
        if mode == 'fullscreen':
            assert b'\x1b[?1049l' in tail
        return {'mode': mode, 'nativeTitleSeparated': True, 'exclusivePointerHover': mode == 'fullscreen',
                'editorBoundaryClearsHover': mode == 'fullscreen', 'terminalRestored': True,
                'models': False, 'explicitFixtureOnly': True}
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'renderingFourFixes': [run('inline'), run('fullscreen')]}, indent=2))
