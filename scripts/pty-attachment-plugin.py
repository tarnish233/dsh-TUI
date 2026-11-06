#!/usr/bin/env python3
"""Private PTY alias attachment acceptance. Temporary native profiles; no prompts."""
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
started = time.monotonic()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(request['cwd'])
    os.execve(request['node'], [request['node'], request['alias']], request['env'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))
raw = bytearray()
status = None
ready = None

def read_once(timeout=0.03):
    global ready
    available, _, _ = select.select([fd], [], [], timeout)
    if not available:
        return
    try:
        data = os.read(fd, 65536)
    except OSError:
        return
    if not data:
        return
    raw.extend(data)
    for query, answer in [(b'\x1b[c', b'\x1b[?1;2c'),
                          (b'\x1b[?u', b'\x1b[?0u'),
                          (b'\x1b[6n', b'\x1b[1;1R'),
                          (b'\x1b[16t', b'\x1b[6;16;8t')]:
        if query in data:
            try:
                os.write(fd, answer)
            except OSError:
                pass
    if ready is None and b'\x1b[?1049h' in raw and b'ready' in raw:
        ready = round(time.monotonic() - started, 3)

def exited():
    global status
    if status is None:
        found, value = os.waitpid(pid, os.WNOHANG)
        if found:
            status = value
    return status is not None

try:
    mode = request['scenario']
    if mode == 'interrupt-install':
        deadline = started + 15
        while not Path(request['startedFile']).exists() and not exited() and time.monotonic() < deadline:
            read_once()
        assert Path(request['startedFile']).exists(), bytes(raw[-2500:])
        assert b'\x1b[?2004h' not in raw and b'\x1b[?1049h' not in raw
        os.kill(pid, signal.SIGINT)
    elif request['expectReady']:
        deadline = started + 25
        while ready is None and not exited() and time.monotonic() < deadline:
            read_once()
        assert ready is not None, bytes(raw[-2500:])
        assert b'\x1b[?1049h' in raw, 'plain alias startup must enter default fullscreen'
        os.write(fd, b'/exit\r')
    else:
        deadline = started + 25
        while not exited() and time.monotonic() < deadline:
            read_once()
        assert exited(), bytes(raw[-2500:])
        assert ready is None
        assert b'\x1b[?2004h' not in raw and b'\x1b[?1049h' not in raw
    deadline = time.monotonic() + 10
    while not exited() and time.monotonic() < deadline:
        read_once()
    assert exited(), bytes(raw[-2500:])
    for _ in range(5):
        read_once(0.01)
    code = os.waitstatus_to_exitcode(status)
    assert code == request['expectedExit'], (mode, code, bytes(raw[-2500:]))
    assert b'Working' not in raw, 'test must never send a model prompt'
    if request['expectReady']:
        assert b'\x1b[?2004l' in raw and b'\x1b[?25h' in raw and b'\x1b[?1049l' in raw
    if 'forbiddenMarker' in request:
        assert request['forbiddenMarker'].encode() not in raw, 'raw package diagnostics leaked'
    Path(request['output']).write_bytes(raw)
    print(json.dumps({
        'scenario': mode,
        'invocation': 'dsh-tui (no arguments)',
        'readySeconds': ready,
        'fullscreen': b'\x1b[?1049h' in raw,
        'attachNotice': b'attaching the local application' in raw,
        'activationFailure': b'did not activate the terminal application' in raw,
        'exit': code,
        'terminalRestored': True,
        'noModelPromptSent': True,
        'durationSeconds': round(time.monotonic() - started, 3),
    }))
finally:
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    os.close(fd)
