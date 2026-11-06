#!/usr/bin/env python3
"""Verify an uncommitted Git source snapshot installs/builds without old dist.

Only tracked and non-ignored source files are copied; existing node_modules,
credentials, caches and generated builds are excluded. All package installation
is offline, and native runtime tests use temporary homes and hermetic streams.
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'artifacts' / 'clean-install'


def run(command, cwd, label, env):
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True,
                               start_new_session=True, env=env)
    timed_out = False
    try:
        output, _ = process.communicate(timeout=240)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / (label + '.log')).write_text(output, encoding='utf8')
    if process.returncode or timed_out:
        raise AssertionError(label + ' failed (exit ' + str(process.returncode) +
                             ', timeout=' + str(timed_out) + '):\n' +
                             '\n'.join(output.splitlines()[-70:]))
    return {'step': label, 'exit': process.returncode,
            'durationSeconds': round(time.monotonic() - started, 2)}


def main():
    pnpm, node = shutil.which('pnpm'), shutil.which('node')
    assert pnpm and node, 'pnpm and node are required'
    listing = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others',
                              '--exclude-standard'], cwd=ROOT, check=True,
                             stdout=subprocess.PIPE).stdout
    sources = [os.fsdecode(name) for name in listing.split(b'\0') if name]
    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    clone = Path(tempfile.mkdtemp(prefix='clean-acceptance-', dir=cache))
    try:
        home = clone / '.isolated-home'
        home.mkdir()
        env = {
            'PATH': os.environ.get('PATH', os.defpath),
            'TMPDIR': tempfile.gettempdir(),
            'HOME': str(home),
            'DSH_HOME': str(home / 'dsh'),
            'LANG': 'en_US.UTF-8',
            'TERM': 'xterm-256color',
            'CI': '1',
            'NPM_CONFIG_USERCONFIG': os.devnull,
            'DSH_TELEMETRY_DISABLED': '1',
        }
        for name in sources:
            source = ROOT / name
            if not source.exists() and not source.is_symlink():
                continue  # A deleted tracked file is absent in this snapshot.
            parts = Path(name).parts
            assert 'node_modules' not in parts and '.cache' not in parts
            assert not name.startswith(('lib/', 'vendor/pi-tui/dist/')), 'generated output is tracked'
            assert Path(name).name not in ('.credentials.yaml', 'auth.json',
                                           'credentials.json', '.env', '.npmrc'), 'secret file is tracked'
            destination = clone / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                destination.symlink_to(os.readlink(source))
            else:
                shutil.copy2(source, destination)
        assert not (clone / 'lib').exists()
        assert not (clone / 'vendor/pi-tui/dist').exists()
        results = [run([pnpm, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts'],
                       clone, 'install-offline-frozen', env)]
        results.append(run([pnpm, 'check'], clone, 'check-clean-source', env))
        results.append(run([node, '--input-type=module', '-e',
                           "import { realpathSync, readFileSync } from 'node:fs'; "
                           "import { createRequire } from 'node:module'; "
                           "const require=createRequire(import.meta.url); "
                           "const actual=realpathSync(require.resolve('#pi-tui')); "
                           "const expected=realpathSync('./vendor/pi-tui/dist/index.js'); "
                           "if(actual!==expected) throw new Error(actual); "
                           "await import('./src/app.ts'); await import('./lib/app.js'); "
                           "const {VERSION}=await import('./lib/version.js'); "
                           "if(JSON.parse(readFileSync('./package.json','utf8')).version!==VERSION) "
                           "throw new Error('package/application version mismatch'); "
                           "console.log('private vendored TUI, source/compiled App and version OK')"],
                           clone, 'private-tui-and-app-import', env))
        results.append(run([node, 'bin/dsh-tui.mjs', '--help'], clone, 'cli-help', env))
        results.append(run([node, 'bin/dsh-tui.mjs', '--version'], clone, 'cli-version', env))
        report = {'cleanInstallAcceptance': results, 'sourceFiles': len(sources),
                  'copiedOldNodeModulesOrDist': False, 'offline': True,
                  'temporaryHome': True, 'inheritedTerminalCapabilities': False}
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf8')
        print(json.dumps(report, indent=2))
    finally:
        shutil.rmtree(clone, ignore_errors=True)


if __name__ == '__main__':
    main()
