#!/usr/bin/env python3
"""Transfer a signed IPA to the paired Mac and install it without compiling."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa', type=Path)
    parser.add_argument('--config', type=Path,
                        default=Path.home() / '.local/share/zorid/macos-install-private.json')
    args = parser.parse_args()
    ipa = args.ipa.resolve()
    helper = Path(__file__).with_name('install-mac.sh').resolve()
    try:
        if not ipa.is_file() or not helper.is_file():
            raise ValueError('IPA or Mac installer is missing')
        config_path = args.config.expanduser()
        if config_path.stat().st_mode & 0o077:
            raise ValueError('The installation config must have mode 0600')
        config = json.loads(config_path.read_text())
        host, user, device = (config[key] for key in ('host', 'user', 'deviceIdentifier'))
        if not all(isinstance(value, str) for value in (host, user, device)):
            raise ValueError('Invalid installation config')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', host) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', user):
            raise ValueError('Invalid SSH destination')
        if not re.fullmatch(r'[A-Za-z0-9-]{1,128}', device):
            raise ValueError('Invalid device identifier')
        identity = Path(config['identityFile']).expanduser().resolve()
        if not identity.is_file():
            raise ValueError('The dedicated SSH identity is missing')
    except (OSError, ValueError, KeyError, TypeError):
        print('Cannot load IPA or private Mac installation configuration.', file=sys.stderr)
        return 1

    digest = hashlib.sha256()
    with ipa.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    options = ['-i', str(identity), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
               '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']
    destination = f'{user}@{host}'
    fd, log_path = tempfile.mkstemp(prefix='macos-install-', suffix='.log', dir=config_path.parent)
    remote = None
    installed = False
    cleanup_failed = False
    stage = 'Connect to the Mac'

    with os.fdopen(fd, 'w') as log:
        def run(command, timeout):
            result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
            log.write(result.stdout + result.stderr)
            log.flush()
            if result.returncode:
                raise RuntimeError('Remote command failed')
            return result.stdout

        try:
            remote = run(['ssh', *options, destination,
                          'umask 077; mktemp -d /tmp/zorid-transfer.XXXXXX'], 20).strip()
            if not re.fullmatch(r'/tmp/zorid-transfer\.[A-Za-z0-9]+', remote):
                remote = None
                raise RuntimeError('Invalid remote staging directory')
            stage = 'Transfer the signed IPA'
            print('Transferring signed IPA and installer…', flush=True)
            run(['scp', *options, str(ipa), f'{destination}:{remote}/Zorid.ipa'], 180)
            run(['scp', *options, str(helper), f'{destination}:{remote}/install-mac.sh'], 30)
            stage = 'Install and launch Zorid'
            print('Installing and launching Zorid; keep the iPhone unlocked…', flush=True)
            command = shlex.join(['bash', f'{remote}/install-mac.sh', f'{remote}/Zorid.ipa',
                                  device, digest.hexdigest()])
            run(['ssh', *options, destination, command], 300)
            installed = True
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            log.write(f'\n{type(error).__name__} during {stage}\n')
            print(f'{stage} failed. Private diagnostics: {log_path}', file=sys.stderr)
        finally:
            if remote:
                try:
                    run(['ssh', *options, destination, shlex.join(['rm', '-rf', '--', remote])], 20)
                except (OSError, RuntimeError, subprocess.TimeoutExpired):
                    cleanup_failed = True
                    print(f'Mac transfer cleanup failed. Private diagnostics: {log_path}', file=sys.stderr)

    if installed:
        print('Zorid was installed and launched on the selected iPhone.')
    return 0 if installed and not cleanup_failed else 1


if __name__ == '__main__':
    raise SystemExit(main())
