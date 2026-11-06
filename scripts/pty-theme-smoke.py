#!/usr/bin/env python3
"""DeepSeek theme/startup acceptance through the real CLI/PTY. Demo only.

Runs in temporary configuration directories. It never connects to a model or
changes native DSH configuration. Cell colors/layout are independently checked
by test/app-theme.test.ts; this checks actual terminal framing and restoration.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import struct
import sys
import termios

sys.dont_write_bytecode = True
# Deterministic terminal capability for our child CLI, not a user config change.
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location(
    'pty_cancel_smoke', Path(__file__).with_name('pty-cancel-smoke.py'))
assert spec and spec.loader
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
Session = helper.Session
common_spec = importlib.util.spec_from_file_location('pty_common', Path(__file__).with_name('pty-common.py'))
assert common_spec and common_spec.loader
common = importlib.util.module_from_spec(common_spec)
common_spec.loader.exec_module(common)
BRAND_BLUE = common.BRAND_BLUE  # 品牌蓝镜像,与 src/ui/brand.ts 同步(app-theme 守卫测试锁定)
CC_DARK_TEXT_BLUE = common.BRAND_BLUE  # 单蓝:正文 accent 即品牌蓝
HEADING_BLUE = common.HEADING_BLUE
BLOCKS = '\u2580\u2584\u2588\u2596\u2597\u2598\u2599\u259a\u259b\u259c\u259d\u259e\u259f'


def resize(session, columns, rows):
    fcntl.ioctl(session.fd, termios.TIOCSWINSZ,
                struct.pack('HHHH', rows, columns, 0, 0))
    os.kill(session.pid, signal.SIGWINCH)


def close_panel(session, draft):
    offset = len(session.raw)
    session.send(b'\x1b')
    session.wait_for(draft, offset)
    # Wait for resolved Esc/editor focus before another modifier key.
    session.wait_for(b'\x1b[7m \x1b[27m', offset)


def theme_startup(mode):
    session = Session(mode, 'deepseek-theme')
    try:
        session.wait_for(b'ready')
        session.wait_for(b'DeepSeek Harness')
        session.wait_for(b'DEMO / NO MODEL CALLS')
        startup = bytes(session.raw)
        assert common.LOGO_BLUE in startup, (mode, 'missing DeepSeek logo asset blue')
        assert BRAND_BLUE in startup, (mode, 'missing 品牌蓝主档 (tagline/footer chrome)')
        assert CC_DARK_TEXT_BLUE in startup, (mode, 'missing cc-dark blue accent (tagline/footer)')
        assert any(char.encode() in startup for char in BLOCKS), (mode, 'missing character-block logo')
        assert '🐳'.encode() not in startup and '🐋'.encode() not in startup
        assert b'Claude Code' not in startup

        draft = b'Blue theme retained draft'
        session.send(draft)
        session.wait_for(draft)
        opened = len(session.raw)
        session.send(b'\x1bOP')
        session.wait_for(b'Help', opened)
        assert HEADING_BLUE in session.raw[opened:], (mode, 'Help did not render in cc-dark blueBright')
        session.send(b'\r19')
        resized = len(session.raw)
        resize(session, 120, 36)
        session.wait_for(b'Help', resized)
        assert b'Working' not in session.raw[opened:], (mode, 'read-only Help executed input')
        close_panel(session, draft)

        models = len(session.raw)
        session.send(b'\x1bp')
        session.wait_for(b'Choose model', models)
        assert HEADING_BLUE in session.raw[models:], (mode, 'model picker did not render in cc-dark blueBright')
        session.send(b'does-not-exist-for-theme')
        session.wait_for(b'does-not-exist-for-theme', models)
        session.send(b'\r\t\x1b[Z')
        resized = len(session.raw)
        resize(session, 80, 22)
        session.wait_for(b'Choose model', resized)
        assert b'Working' not in session.raw[models:], (mode, 'model search submitted a prompt')
        close_panel(session, draft)

        narrow = len(session.raw)
        resize(session, 40, 22)
        session.wait_for(b'DeepSeek Harness', narrow)
        session.wait_for(b'DEMO / NO MODEL CALLS', narrow)
        wide = len(session.raw)
        resize(session, 110, 32)
        session.wait_for(draft, wide)
        session.wait_for(b'DeepSeek Harness', wide)
        assert b'Working' not in session.raw, (mode, 'theme acceptance started a model turn')

        exit_offset = len(session.raw)
        session.send(b'\x03')
        session.wait_for(b'again to exit', exit_offset)
        session.send(b'\x03')
        result = session.finish(restore_offset=exit_offset)
        result.update({'ccDarkBlue': True, 'logoPixelBlue': True,
                       'blueHelpAndModelPicker': True, 'resize': True,
                       'draftPreserved': True, 'noModelCalls': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptyThemeAcceptance': [theme_startup('inline'),
                                            theme_startup('fullscreen')]}, indent=2))
