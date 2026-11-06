#!/usr/bin/env python3
"""Real CLI/PTy image payload acceptance, not a claim of terminal pixel rendering.

All images and tool calls are deterministic offline fixtures. Native image APC
bytes remain in the private PTY; no user's clipboard, model, or live pane is used.
"""
import base64
import fcntl
import hashlib
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
import unicodedata
import zlib

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Session = helper.Session


def settle(session, limit=0.35):
    quiet = 0
    while quiet < 3 and limit > 0:
        before = len(session.raw)
        session.read(0.05)
        quiet = quiet + 1 if before == len(session.raw) else 0
        limit -= 0.05


def frame(session, columns=80, rows=32):
    settle(session)
    result = subprocess.run([helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'), str(columns), str(rows)],
                            input=bytes(session.raw), capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)


def text(screen):
    return '\n'.join(screen['lines'])


def resize(session, columns, rows):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)
    settle(session)


def click(session, x, y):
    session.send(f'\x1b[<0;{x + 1};{y + 1}M'.encode())
    settle(session)
    session.send(f'\x1b[<0;{x + 1};{y + 1}m'.encode())
    settle(session)


def complete_pngs(raw):
    """Validate actual complete APC payloads including chunked transmissions."""
    pending = None
    pngs = []
    for match in re.finditer(rb'\x1b_G([^;]*);([A-Za-z0-9+/=]*)\x1b\\', raw):
        controls = dict(part.split(b'=', 1) for part in match.group(1).split(b',') if b'=' in part)
        if controls.get(b'a') in (b'T', b't'):
            pending = bytearray(match.group(2)) if controls.get(b'f') == b'100' else None
        elif pending is not None and b'a' not in controls:
            pending.extend(match.group(2))
        else:
            continue
        if pending is None or controls.get(b'm') == b'1':
            continue
        data = base64.b64decode(bytes(pending), validate=True)
        pending = None
        assert data[:8] == b'\x89PNG\r\n\x1a\n', 'terminal received non-PNG bytes as f=100'
        offset, saw_end, idat = 8, False, bytearray()
        while offset + 12 <= len(data):
            length = struct.unpack('>I', data[offset:offset + 4])[0]
            kind = data[offset + 4:offset + 8]
            chunk = data[offset + 8:offset + 8 + length]
            crc = struct.unpack('>I', data[offset + 8 + length:offset + 12 + length])[0]
            assert (zlib.crc32(kind + chunk) & 0xffffffff) == crc, 'PNG CRC mismatch'
            if kind == b'IDAT':
                idat.extend(chunk)
            if kind == b'IEND':
                saw_end = True
                break
            offset += 12 + length
        assert saw_end and idat, 'truncated PNG reached terminal'
        assert zlib.decompress(idat), 'PNG raster stream cannot be decoded'
        pngs.append(hashlib.sha256(data).hexdigest())
    return pngs


def wait_idle(session):
    deadline = time.monotonic() + 20
    while True:
        screen = frame(session)
        if 'fixture' in text(screen) and re.search(r'\bready\b', text(screen)):
            return screen
        assert not session.poll_exit(), session.tail()
        assert time.monotonic() < deadline, 'images fixture did not settle'


def wait_viewer(session, columns=80, rows=32):
    deadline = time.monotonic() + 8
    while True:
        screen = frame(session, columns, rows)
        body = text(screen)
        if 'Image details' in body and 'Ready' in body:
            return screen
        assert time.monotonic() < deadline, body


def run(mode, term_program):
    os.environ['TERM'] = 'xterm-rex' if term_program == 'rex' else 'xterm-ghostty'
    os.environ['TERM_PROGRAM'] = term_program
    os.environ['COLORTERM'] = 'truecolor'
    os.environ.pop('PI_IMAGE_PROTOCOL', None)
    os.environ.pop('TMUX', None)
    session = Session(mode, 'image-' + term_program, settings={
        'showThinking': False, 'groupTools': True, 'expandTools': False,
    })
    try:
        session.wait_for(b'ready')
        resize(session, 80, 32)
        session.send(b'images\r')
        wait_idle(session)
        assert not complete_pngs(bytes(session.raw)), 'folded markers unexpectedly fetched/painted bytes'
        session.send(b'PTY image retained draft')
        session.send(b'\x18\t')
        screen = wait_viewer(session)
        assert 'Image 7 of 7' in text(screen), text(screen)
        first = complete_pngs(bytes(session.raw))
        assert first, 'image viewer never transmitted a complete PNG'
        # Navigate to the assistant JPEG occurrence and prove PNG conversion.
        for _ in range(3):
            session.send(b'[')
            screen = wait_viewer(session)
        assert 'JPEG' in text(screen), 'JPEG source metadata vanished'
        pngs = complete_pngs(bytes(session.raw))
        assert len(set(pngs)) >= 2, 'navigation did not produce the distinct JPEG-to-PNG image'
        before = len(session.raw)
        session.send(b'\x0c')  # unknown global redraw may be inert inside viewer
        settle(session)
        resize(session, 80, 24)
        screen = wait_viewer(session, 80, 24)
        assert complete_pngs(bytes(session.raw[before:])), 'height-only redraw reused a stale image id without bytes'
        resize(session, 40, 24)
        screen = wait_viewer(session, 40, 24)
        width = lambda line: sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in line)
        assert all(width(line) <= 40 for line in screen['lines']), 'narrow viewport overflow'
        if mode == 'fullscreen':
            row = next(i for i, line in enumerate(screen['lines']) if 'Close' in line)
            click(session, screen['lines'][row].index('Close') + 1, row)
        else:
            session.send(b'\x1b')
        screen = frame(session, 40, 24)
        assert 'Image details' not in text(screen), text(screen)
        assert 'PTY image retained draft' in text(screen), 'viewer discarded the draft'
        session.send(b'\x15')
        settle(session)
        begin = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', offset=begin)
        session.send(b'\x03')
        result = session.finish(restore_offset=begin)
        result.update({'termProgram': term_program, 'validPngTransmissions': len(pngs),
                       'distinctPngs': len(set(pngs)), 'lazyReads': True,
                       'jpegToPng': True, 'resizeAndDraft': True,
                       'pixelRenderingTested': False})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptyImagePayloadAcceptance': [run(mode, terminal) for terminal in ('rex', 'ghostty')
                                                  for mode in ('fullscreen', 'inline')]}, indent=2))
