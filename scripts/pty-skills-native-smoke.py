#!/usr/bin/env python3
"""Production native TUI + private profile/home + hermetic LLM; no real user skills or providers."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import sys
import termios
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('native_skills_helpers', Path(__file__).with_name('pty-native-plugin.py'))
assert spec and spec.loader
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
helper = native.helper


def frame(session):
    for _ in range(3):
        session.read(0.02)
    result = subprocess.run([helper.NODE, str(helper.ROOT / 'scripts/ansi-screen.ts'), '140', '54'],
                            input=bytes(session.raw), capture_output=True, check=True, timeout=5)
    return json.loads(result.stdout)['lines']


def wait_frame(session, predicate, label, timeout=15):
    deadline = time.monotonic() + timeout
    lines = []
    while time.monotonic() < deadline:
        lines = frame(session)
        if predicate(lines):
            return lines
        assert not session.poll_exit(), 'native process exited before ' + label
    raise AssertionError(label + ' timed out:\n' + '\n'.join(lines))


def run(request, mode):
    helper.OUT = Path(request['artifactsDir'])
    helper.OUT.mkdir(parents=True, exist_ok=True)
    session = native.NativeSession(request, mode, 'skills-real-menu')
    try:
        session.wait_for(b'ready', timeout=20)
        fcntl.ioctl(session.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 54, 140, 0, 0))
        os.kill(session.pid, signal.SIGWINCH)
        wait_frame(session, lambda lines: any(' · ready' in line for line in lines), 'native startup')
        session.send(b'/skill-stu')
        initial = wait_frame(session, lambda lines: any('skill-studio' in line and 'Skill' in line
                                                       and 'Native home skill-studio metadata' in line for line in lines),
                             'first native /skill-stu menu without any message')
        assert not any('Working' in line for line in initial), 'menu must not call a model'
        session.send(b'\x1b')
        wait_frame(session, lambda lines: not any('Native home skill-studio metadata' in line for line in lines), 'Esc closes skill candidate')
        session.send(b'\x15ordinary native first message\r')
        wait_frame(session, lambda lines: 'NATIVE_SKILL_OFFLINE_RESPONSE' in '\n'.join(lines)
                   and any(' · ready' in line for line in lines), 'ordinary model fixture completion')
        session.send(b'/skill-stu')
        wait_frame(session, lambda lines: any('skill-studio' in line and 'Skill' in line
                                             and 'Native home skill-studio metadata' in line for line in lines),
                   'same-prefix menu after an ordinary first message')
        # Do not use Tab first: Enter must submit the selected full name through
        # the real onSubmitContent path, and DSH must inject that exact skill.
        session.send(b'\r')
        wait_frame(session, lambda lines: 'NATIVE_SKILL_STUDIO_ENTER_RESPONSE' in '\n'.join(lines)
                   and any(' · ready' in line for line in lines), 'single Enter submits completed skill and native body')
        session.send(b'/skill-stu')
        wait_frame(session, lambda lines: any('skill-studio' in line and 'Skill' in line
                                             and 'Native home skill-studio metadata' in line for line in lines), 'another native skill menu')
        session.send(b'\t')
        wait_frame(session, lambda lines: any('❯ /skill-studio' in line for line in lines), 'Tab still only inserts the native name')
        session.send(b'\x1bOP')
        session.wait_for(b'Help')
        session.send(b'\x1b[F')
        wait_frame(session, lambda lines: any('Skills 6' in line for line in lines)
                   and any('/skill-studio' in line for line in lines), 'production Help exposes native home catalog')
        session.send(b'\x1b')
        # The composer now remains visible behind a floating Help modal. Its
        # draft alone cannot prove Esc was processed (or /exit can race it).
        wait_frame(session, lambda lines: not any('┌─ Help' in line for line in lines)
                   and any('❯ /skill-studio' in line for line in lines), 'Help closes and preserves the draft')
        offset = len(session.raw)
        session.send(b'\x15/exit\r')
        deadline = time.monotonic() + 12
        while not session.poll_exit():
            session.read(0.03)
            if time.monotonic() >= deadline:
                raise AssertionError('native Skills exit did not settle:\n' + '\n'.join(frame(session)))
        result = session.finish(restore_offset=offset)
        result.update({'nativeProfile': True, 'demo': False, 'firstMenuBeforeMessage': True,
                       'ordinaryFirstMessageThenSamePrefix': True, 'nativeUserHomeCatalog': 6,
                       'enterSubmitsCompletedSkillAndBody': True,
                       'productionPluginAndTerminalLease': True, 'readonlyHelp': True,
                       'draftPreserved': True, 'hermeticStream': True})
        return result
    finally:
        # Only this fixture's own private PID may be killed on failure.
        session.close()


if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    print(json.dumps({'nativeSkillsPty': [run(request, mode) for mode in request.get('modes', ['inline', 'fullscreen'])]}, indent=2))
