#!/usr/bin/env python3
"""Static blue/white character-logo acceptance, identical on every terminal.

Offline CLI demo in temporary config directories. No model/config/credential
access; no Rex image special case or startup animation.
"""
import fcntl
import importlib.util
import json
import os
import re
from pathlib import Path
import signal
import struct
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
common_spec = importlib.util.spec_from_file_location('pty_common', Path(__file__).with_name('pty-common.py'))
assert common_spec and common_spec.loader
common = importlib.util.module_from_spec(common_spec)
common_spec.loader.exec_module(common)
BLUE = common.LOGO_BLUE  # DeepSeek logo 资产蓝,与 src/ui/logo.ts 同步
WHITE_FG = common.WHITE_FG
WHITE_BG = common.WHITE_BG
BLOCKS = '\u2580\u2584\u2588\u2596\u2597\u2598\u2599\u259a\u259b\u259c\u259d\u259e\u259f'
APP_VERSION = json.loads((helper.ROOT / 'package.json').read_text(encoding='utf8'))['version']


def collect_for(session, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        session.read(min(0.02, max(0, deadline - time.monotonic())))
        assert not session.poll_exit(), (session.mode, 'unexpected exit', session.tail())


def finish_idle(session):
    offset = len(session.raw)
    session.send(b'\x03')
    session.wait_for(b'again to exit', offset)
    session.send(b'\x03')
    return session.finish(restore_offset=offset)


def static_logo(mode, protocol):
    os.environ['PI_IMAGE_PROTOCOL'] = protocol
    session = Session(mode, 'static-logo-' + protocol)
    try:
        session.wait_for(b'ready')
        collect_for(session, 0.08)
        assert ('DSH TUI · v' + APP_VERSION).encode() in session.raw, (mode, 'startup version does not match the package')
        assert b'prototype' not in session.raw
        assert BLUE in session.raw
        assert WHITE_FG in session.raw or WHITE_BG in session.raw
        assert any(char.encode() in session.raw for char in BLOCKS)
        assert b'\x1b]1337;File=' not in session.raw
        # Generic Pi fullscreen cleanup a=d is permitted; no logo image is
        # uploaded or placed. Do not change the terminal dependency's cleanup.
        for command in re.findall(rb'\x1b_G(.*?)\x1b\\', session.raw, re.S):
            assert re.search(rb'(?:^|,)a=d(?:,|$)', command), (mode, 'unexpected image upload/placement')
        assert not any(chr(code).encode() in session.raw for code in range(0x2800, 0x2900))
        static = len(session.raw)
        collect_for(session, 0.6)
        assert not any(char.encode() in session.raw[static:] for char in BLOCKS), (mode, 'idle logo was repainted/animated')
        draft = b'Static logo preserves draft'
        session.send(draft); session.wait_for(draft)
        resize_offset = len(session.raw)
        fcntl.ioctl(session.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 22, 40, 0, 0))
        os.kill(session.pid, signal.SIGWINCH)
        session.wait_for(draft, resize_offset)
        session.wait_for(b'DeepSeek Harness', resize_offset)
        assert b'Working' not in session.raw
        result = finish_idle(session)
        result.update({'characterBlocks': True, 'whiteInterior': True, 'noImageProtocol': True,
                       'noStartupAnimation': True, 'resizeAndDraft': True, 'protocolHint': protocol})
        return result
    finally:
        session.close()


def external_sigint(mode):
    os.environ['PI_IMAGE_PROTOCOL'] = 'kitty'
    session = Session(mode, 'static-logo-sigint')
    try:
        session.wait_for(b'ready')
        offset = len(session.raw)
        os.kill(session.pid, signal.SIGINT)
        result = session.finish(code=130, restore_offset=offset)
        result.update({'noLogoTimer': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    results = []
    for mode in ('inline', 'fullscreen'):
        for protocol in ('kitty', 'none'):
            results.append(static_logo(mode, protocol))
        results.append(external_sigint(mode))
    print(json.dumps({'ptyStaticLogoAcceptance': results}, indent=2))
