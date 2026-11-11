"""Exercise the downloaded demo in a disposable, paired live simulator.

Requires a fresh synthetic workspace (no completed sessions). Uses the installed
ios-simulator-testing skill; captures stay in an owner-only local directory.
This does not test physical Screen Time enforcement or widget button delivery.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


class FocusCheck:
    def __init__(self, state, output, helper):
        self.state, self.output, self.helper = state, output, helper
        self.sequence = 0
        self.output.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.output.chmod(0o700)

    def command(self, *arguments):
        self.sequence += 1
        result = subprocess.run(
            ['node', str(self.helper), 'exec', '--state', str(self.state), '--', *arguments],
            capture_output=True, text=True, timeout=150,
        )
        capture = self.output / f'{self.sequence:03d}-{arguments[0]}.log'
        capture.write_text(result.stdout + result.stderr)
        capture.chmod(0o600)
        if result.returncode:
            raise RuntimeError(f'Simulator command failed; see {capture.name}')
        return result.stdout

    def snapshot(self):
        result = json.loads(self.command('snapshot', '--json'))
        if not result.get('success') or not isinstance(result.get('data', {}).get('nodes'), list):
            raise RuntimeError('Simulator returned no usable accessibility tree')
        nodes = result['data']['nodes']
        labels = [node.get('label', '') for node in nodes]
        errors = ('Retry local storage', 'Native surfaces could not update',
                  'Native surfaces could not refresh', 'Shared widget storage is unavailable',
                  'Shared action storage', 'Local storage is not ready')
        if any(error in label for error in errors for label in labels):
            raise AssertionError('Reported storage/surface failure is visible; inspect the private snapshot')
        return nodes

    def wait(self, label, *, contains=False, seconds=20):
        deadline = time.monotonic() + seconds
        while True:
            nodes = self.snapshot()
            matches = [node for node in nodes
                       if (label in node.get('label', '') if contains
                           else node.get('label') == label)]
            if matches:
                return matches
            if time.monotonic() >= deadline:
                raise AssertionError(f'Expected UI state did not appear: {label}')
            time.sleep(0.5)

    def press(self, label, *, contains=False):
        nodes = self.wait(label, contains=contains)
        interactive = [node for node in nodes if node.get('kind') in ('button', 'tab')
                       and node.get('enabled', True)]
        if len(interactive) != 1:
            raise AssertionError(f'Expected exactly one enabled control: {label}')
        self.command('press', '@' + interactive[0]['ref'].lstrip('@'))

    def run(self):
        self.wait('Make room for today.', seconds=60)
        self.press('Calendar, tab,', contains=True)
        self.wait('Your first session goes here')
        print('PASS startup: fresh local storage, no reported storage/surface error', flush=True)
        self.press('Focus, tab,', contains=True)
        self.press('Begin focus')
        self.wait('Pause')
        print('PASS start', flush=True)
        self.press('Pause')
        self.wait('Paused. Take your time.')
        self.wait('Resume focus')
        print('PASS pause', flush=True)
        self.press('Resume focus')
        self.wait('Your timer continues when you leave the app.')
        self.wait('Pause')
        print('PASS resume', flush=True)
        self.press('Finish & save session')
        self.wait('Begin focus')
        # Give the asynchronous publication effect a chance to report failure.
        time.sleep(1)
        self.snapshot()
        self.press('Calendar, tab,', contains=True)
        self.wait('Open focus')
        self.command('screenshot', str(self.output / 'completed-session.png'))
        print('PASS finish: newly saved session appears in Calendar', flush=True)
        self.command('close', 'app.zorid.mobile')
        self.command('open', 'app.zorid.mobile')
        self.wait('Make room for today.', seconds=60)
        self.press('Calendar, tab,', contains=True)
        self.wait('Open focus')
        self.command('screenshot', str(self.output / 'persisted-session.png'))
        print('PASS relaunch: completed session remains in local storage', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--helper', type=Path, default=Path.home() / '.codex/skills/ios-simulator-testing/scripts/simulator.mjs')
    args = parser.parse_args()
    os.umask(0o077)
    check = FocusCheck(args.state, args.out, args.helper)
    try:
        check.run()
    except (AssertionError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        try:
            check.command('screenshot', str(check.output / 'failure.png'))
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
        print(f'FAIL {error}', flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
