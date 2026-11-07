#!/usr/bin/env python3
"""Consecutive native-shaped record groups and name-only links via offline CLI/PTY."""
import importlib.util
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
os.environ['TERM'] = 'xterm-256color'
os.environ['COLORTERM'] = 'truecolor'
spec = importlib.util.spec_from_file_location('record_link_helpers', Path(__file__).with_name('pty-subagent-links-smoke.py'))
assert spec and spec.loader
links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(links)
helpers = links.helpers
helpers.helper.OUT = helpers.helper.ROOT / '.cache' / 'subagent-ui-followup' / 'pty-records'
helpers.helper.OUT.mkdir(parents=True, exist_ok=True)
Session = helpers.Session


def frame(session):
    return links.frame(session, 140, 52)


def wait(session, predicate):
    return links.wait_frame(session, predicate, 140, 52)


def group(session):
    return wait(session, lambda value: any('Subagents:' in line for line in value['lines'])
                and any('❯ PTY record draft' in line for line in value['lines']))


def row_for(screen, title, name):
    rows = [y for y, line in enumerate(screen['lines']) if title in line and name in line]
    assert rows, (title, name, '\n'.join(screen['lines']))
    return rows[0]


def run(mode):
    session = Session(mode, 'subagent-record-links', 'subagent')
    negative = 0
    try:
        session.wait_for(b'Agents')
        helpers.resize(session, 140, 52)
        wait(session, lambda value: any('demo (offline)/deepseek-demo' in line and ' · ready' in line for line in value['lines']))
        session.send(b'PTY record draft')
        screen = group(session)
        assert sum('Subagents:' in line for line in screen['lines']) == 1, 'consecutive records share one group header'
        pairs = [('Subtask status updated', 'Review changes', b'I reviewed the frontend diff'),
                 ('Task message received', 'Explore repository', b'I mapped the transcript projection')]
        opened = len(session.raw)
        for title, name, answer in pairs:
            screen = group(session)
            row = row_for(screen, title, name)
            start, end = links.columns_for(screen, row, name)
            assert all(cell[4] and cell[5] for cell in screen['cells'][row][start:end] if cell[1] != 0), 'only the native name is bold + underlined'
            assert not screen['cells'][row][end][5]
            if mode == 'fullscreen':
                title_start, _ = links.columns_for(screen, row, title)
                for x in [0, title_start + 2, start - 1, end, 139]:
                    helpers.click(session, x, row)
                    screen = group(session)
                    assert not any('session demo-child-' in line for line in screen['lines']), 'non-name cell opened a child'
                    negative += 1
                before = len(session.raw)
                helpers.click(session, start + 1, row)
                session.wait_for(answer, before)
                session.send(b'\x1b')
                group(session)

        # Ctrl+O and the group header are disclosure controls, not child links.
        session.send(b'\x0f')
        expanded = group(session)
        assert any('Review changes' in line for line in expanded['lines'])
        assert any('Subtask status updated' in line for line in expanded['lines'])
        session.send(b'\x0f')
        collapsed = group(session)
        if mode == 'fullscreen':
            header = next(y for y, line in enumerate(collapsed['lines']) if 'Subagents:' in line)
            x, _ = links.columns_for(collapsed, header, 'Subagents:')
            helpers.click(session, x + 2, header)
            expanded = group(session)
            assert not any('session demo-child-' in line for line in expanded['lines']), 'group header must not open any child'
            helpers.click(session, x + 2, header)
            group(session)

        session.send(b'\x03'); helpers.settle(session)
        assert not session.poll_exit(), 'clearing the retained draft must not exit'
        session.send(b'\x03')
        result = session.finish(restore_offset=opened)
        result.update({'recordGrouping': True, 'nativeNamesStyled': True,
                       'nameOnlyNavigation': mode == 'fullscreen', 'nonNameClicks': negative,
                       'bothMessageKinds': True, 'existingDisclosureControls': True,
                       'draftPreserved': True, 'hermeticFixture': True})
        return result
    finally:
        session.close()


if __name__ == '__main__':
    print(json.dumps({'ptySubagentRecordLinks': [run('inline'), run('fullscreen')]}, indent=2))
