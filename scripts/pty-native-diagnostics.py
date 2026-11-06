#!/usr/bin/env python3
"""Native same-process JS diagnostic isolation in a private PTY; synthetic only."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import sys
import termios
import time

request = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(request['cwd'])
    os.execve(request['node'], [request['node'], request['bin'], '--profile', 'dsh-tui',
                              '--config-dir', request['configDir'], '--' + request['mode']], request['env'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
raw = bytearray()
status = None
serial = 0
log = Path(request['configDir']) / 'logs' / 'terminal-diagnostics.log'

def read_once(timeout=0.03):
    available, _, _ = select.select([fd], [], [], timeout)
    if not available:
        return
    try:
        data = os.read(fd, 65536)
    except OSError:
        return
    raw.extend(data)
    for query, answer in [(b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[?u', b'\x1b[?0u'),
                          (b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[16t', b'\x1b[6;16;8t')]:
        if query in data:
            try: os.write(fd, answer)
            except OSError: pass

def exited():
    global status
    if status is None:
        found, value = os.waitpid(pid, os.WNOHANG)
        if found: status = value
    return status is not None

def wait_for(marker, offset=0, timeout=15):
    deadline = time.monotonic() + timeout
    while marker not in raw[offset:]:
        read_once()
        assert not exited(), (marker, bytes(raw[-3000:]))
        assert time.monotonic() < deadline, (marker, bytes(raw[-3000:]))

def log_text():
    try: return log.read_text()
    except OSError: return ''

def action(kind):
    global serial
    serial += 1
    Path(request['control']).write_text(json.dumps({'serial': serial, 'kind': kind}))
    deadline = time.monotonic() + 10
    while True:
        read_once()
        try: ack = json.loads(Path(request['ack']).read_text())
        except (OSError, ValueError): ack = {}
        if ack.get('serial') == serial: return
        assert not exited(), (kind, bytes(raw[-3000:]))
        assert time.monotonic() < deadline, (kind, bytes(raw[-3000:]))

def wait_log(text):
    deadline = time.monotonic() + 10
    while text not in log_text():
        read_once()
        assert not exited(), (text, bytes(raw[-3000:]))
        assert time.monotonic() < deadline, (text, log_text())

try:
    wait_for(b'ready')
    draft = b'draft remains private and intact'
    os.write(fd, draft)
    wait_for(draft)
    offset = len(raw)
    action('listing')
    wait_log('model listing from')
    assert b'model listing from' not in raw[offset:], 'native catalog diagnostics reached the editor/terminal'
    action('stdout')
    wait_log('ordinary synthetic chatter')
    assert b'ordinary synthetic chatter' not in raw[offset:], 'unclassified stdout chatter reached the terminal'
    action('partial-secret')
    wait_log('[redacted]')
    assert 'synthetic-private-diagnostic-marker' not in log_text()
    assert b'synthetic-private-diagnostic-marker' not in raw, 'a split diagnostic secret leaked'
    action('warning')
    wait_log('synthetic diagnostic warning')
    wait_for(b'Native warning', offset)
    repaint = len(raw)
    os.write(fd, b'\x0c')
    wait_for(draft, repaint)
    assert b'model listing from' not in raw[repaint:]
    assert b'ordinary synthetic chatter' not in raw[repaint:]
    if request['scenario'] == 'remount':
        patch = Path(request['profileDir']) / 'cordis.patch.yml'
        original = patch.read_text()
        off = len(raw)
        rows = json.loads(original)
        patch.write_text(json.dumps(rows + [{'id': 'dsh-tui', 'disabled': True}]))
        wait_for(b'\x1b[?2004l', off)
        visible = len(raw)
        deadline = time.monotonic() + 12
        while b'ordinary synthetic chatter' not in raw[visible:]:
            action('stdout')
            for _ in range(6): read_once(0.02)
            assert time.monotonic() < deadline, 'capture did not release after bounded frontend cleanup'
        on = len(raw)
        patch.write_text(original)
        wait_for(b'\x1b[?2004h', on)
        wait_for(b'ready', on)
        reloaded = len(raw)
        action('listing')
        wait_log('model listing from')
        for _ in range(10): read_once(0.02)
        assert b'model listing from' not in raw[reloaded:], 'capture was not reinstalled on HMR remount'
        os.write(fd, b'/exit\r')
    elif request['scenario'] == 'fatal':
        offset = len(raw)
        serial += 1
        Path(request['control']).write_text(json.dumps({'serial': serial, 'kind': 'fatal'}))
    else:
        paused = len(raw)
        os.write(fd, b'\x1a')
        wait_for(b'\x1b[?2004l', paused)
        end = time.monotonic() + 0.15
        while time.monotonic() < end: read_once(0.01)
        resumed = len(raw)
        os.kill(pid, signal.SIGCONT)
        wait_for(b'\x1b[?2004h', resumed)
        wait_for(draft, resumed)
        visible = len(raw)
        action('listing')
        for _ in range(8): read_once(0.02)
        assert b'model listing from' not in raw[visible:], 'capture was lost across suspend/resume'
        os.write(fd, b'\x15/exit\r')
    deadline = time.monotonic() + 12
    while not exited() and time.monotonic() < deadline: read_once()
    assert exited(), bytes(raw[-3000:])
    for _ in range(6): read_once(0.01)
    code = os.waitstatus_to_exitcode(status)
    expected = 1 if request['scenario'] == 'fatal' else 0
    assert code == expected, (code, bytes(raw[-4000:]))
    assert b'\x1b[?2004l' in raw and b'\x1b[?25h' in raw
    if request['mode'] == 'fullscreen': assert b'\x1b[?1049l' in raw
    if request['scenario'] == 'fatal':
        suffix = bytes(raw[offset:])
        assert b'synthetic-native-fatal-diagnostic' in suffix
        assert suffix.index(b'\x1b[?2004l') < suffix.index(b'synthetic-native-fatal-diagnostic'), 'fatal output preceded renderer restoration'
    assert b'Working' not in raw, 'fixture must send no model prompt'
    assert log.stat().st_mode & 0o777 == 0o600
    Path(request['output']).write_bytes(raw)
    print(json.dumps({'mode': request['mode'], 'scenario': request['scenario'], 'exit': code,
                      'catalogLogIsolated': True, 'stdoutLogIsolated': True, 'splitSecretRedacted': True,
                      'warningVisible': True, 'draftPreserved': True, 'terminalRestored': True,
                      'fatalVisibleAfterRestore': request['scenario'] == 'fatal', 'noModelCall': True}))
finally:
    if status is None:
        try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
        except ProcessLookupError: pass
    os.close(fd)
