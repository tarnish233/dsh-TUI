#!/usr/bin/env python3
"""Event-driven progress retirement and /agent history through offline CLI/PTY."""
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location('pty_retirement_helpers', Path(__file__).with_name('pty-subagent-progress-smoke.py'))
assert spec and spec.loader
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)
helpers = progress.helpers
helpers.helper.OUT = helpers.helper.ROOT / '.cache' / 'subagent-startup-research' / 'pty-retirement'
Session = helpers.Session


def text(screen):
    return '\n'.join(screen['lines'])


def wait(session, predicate):
    return progress.wait_frame(session, predicate)


def open_history(session):
    # Stash the retained root draft before typing a UI-owned slash command.
    # This is the one existing Editor's native stash/restore operation.
    session.send(b'\x13')
    wait(session, lambda value: '❯ PTY retirement draft' not in text(value))
    session.send(b'/agent\r')
    return wait(session, helpers.agents_overlay_visible)


def return_from_child(session):
    session.send(b'\x1b')
    wait(session, helpers.agents_overlay_visible)
    session.send(b'\x1b')
    wait(session, lambda value: not helpers.agents_overlay_visible(value))


def restored_root(session):
    session.send(b'\x13')
    value = wait(session, lambda screen: '❯ PTY retirement draft' in text(screen)
                 and not helpers.agents_overlay_visible(screen))
    assert not any('● Agents' in line for line in value['lines']), 'all settled children must release the progress rows'
    assert not session.poll_exit(), 'retiring progress must not quit the root TUI'
    return value


def run(mode):
    session = Session(mode, 'subagent-retirement', 'subagent')
    try:
        session.wait_for(b'Agents')
        helpers.resize(session)
        wait(session, lambda value: any('demo (offline)/deepseek-demo' in line and ' · ready' in line
                                       for line in value['lines']))
        session.send(b'PTY retirement draft')
        initial = wait(session, lambda value: '❯ PTY retirement draft' in text(value)
                       and any('● Agents' in line for line in value['lines']))
        header = next(y for y, line in enumerate(initial['lines']) if '● Agents' in line)
        prompt = next(y for y, line in enumerate(initial['lines']) if '❯ PTY retirement draft' in line)
        row = next(y for y, line in enumerate(initial['lines']) if header < y < prompt and 'Explore repository' in line)
        assert 'reading src/state/transcript.ts' in initial['lines'][row + 1], 'running work keeps its second activity line'
        assert not any('Review changes' in line or 'Verify build' in line
                       for line in initial['lines'][header + 1:prompt]), 'settled history is absent from active progress'
        opened = len(session.raw)

        history = open_history(session)
        for label in ['Explore repository', 'Review changes', 'Verify build', 'Run focused tests', 'External research']:
            assert label in text(history), 'native history was lost: ' + label
        # The default deterministic fixture has one active local child. A native
        # Stop admission is followed by its own stopped upsert; no UI mutation.
        session.send(b's')
        wait(session, lambda value: helpers.agents_overlay_visible(value)
             and any('Explore repository' in line and 'stopped' in line for line in value['lines']))
        session.send(b'\x1b')
        wait(session, lambda value: not helpers.agents_overlay_visible(value))
        restored_root(session)

        # Reactivate that durable continuable child using its real fixture Reply
        # control. Keep the original root draft stashed while sending new text.
        open_history(session)
        session.send(b'r')
        wait(session, lambda value: 'Replying to Explore repository' in text(value)
             and not helpers.agents_overlay_visible(value))
        session.send(b'PTY native continuation\r')
        session.wait_for(b'Reply accepted for Explore repository (queue)', opened)
        wait(session, lambda value: not any('● Agents' in line for line in value['lines'])
             and 'Replying to Explore repository' in text(value))
        # Completion retires the row even with an explicit idle reply target;
        # the destination itself stays visible until the user leaves it.
        session.send(b'\x1b')
        wait(session, lambda value: 'Replying to Explore repository' not in text(value))
        restored_root(session)

        # A completed child is still readable through /agent, with native idle
        # status and its durable continuation; no auto-delete or new Agent.
        history = open_history(session)
        assert any('Explore repository' in line and 'idle' in line for line in history['lines'])
        session.send(b'\r')
        session.wait_for(b'Follow-up received', opened)
        child = wait(session, lambda value: 'Follow-up received' in text(value)
                     and 'PTY native continuation' in text(value))
        assert 'idle' in text(child)
        return_from_child(session)
        restored_root(session)

        # Exact idle draft-clear/exit sequence; no third byte after restoration.
        session.send(b'\x03'); helpers.settle(session)
        assert not session.poll_exit(), 'clearing the retained draft must not exit'
        session.send(b'\x03')
        result = session.finish(restore_offset=opened)
        result.update({'twoLineActivity': True, 'settledProgressRetired': True,
                       'explicitIdleReplyDoesNotPinProgress': True, 'agentHistoryCommand': True,
                       'nativeContinuationHistory': True, 'draftPreserved': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptySubagentRetirementAcceptance': [run('inline'), run('fullscreen')]}, indent=2))
