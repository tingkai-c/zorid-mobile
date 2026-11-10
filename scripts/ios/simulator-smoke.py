"""Bounded simulator launch check; screenshot is evidence, not a behavioral assertion."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

OUTPUT = Path('build/smoke')
DEVICE_FILE = OUTPUT / 'device-id.txt'
APP = Path('build/DerivedData/Build/Products/Release-iphonesimulator/Zorid.app')
BUNDLE = 'app.zorid.mobile'


def simctl(*args, timeout=60):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / 'simctl.log').open('a') as log:
        log.write(f'simctl {" ".join(args)} (timeout={timeout}s)\n')
        try:
            result = subprocess.run(['xcrun', 'simctl', *args], check=True, text=True,
                                    capture_output=True, timeout=timeout)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            log.write(f'{type(error).__name__}\n')
            for value in (error.stdout, error.stderr):
                if isinstance(value, bytes):
                    value = value.decode(errors='replace')
                if value:
                    log.write(value[-40000:] + '\n')
            print(f'simctl {args[0]} failed; diagnostics saved to build/smoke/simctl.log', file=sys.stderr)
            raise
        if result.stderr:
            log.write(result.stderr[-40000:] + '\n')
        return result.stdout


def select_device(listing):
    candidates = []
    for runtime, devices in listing['devices'].items():
        match = re.search(r'SimRuntime\.iOS-([\d-]+)$', runtime)
        if not match:
            continue
        version = tuple(int(part) for part in match[1].split('-'))
        for device in devices:
            if device.get('isAvailable') and device['name'].startswith('iPhone'):
                candidates.append((version, device['name'], device['udid']))
    if not candidates:
        raise RuntimeError('No available iPhone simulator runtime on runner')
    return max(candidates)[2]


def shutdown():
    if DEVICE_FILE.exists():
        try:
            simctl('shutdown', DEVICE_FILE.read_text().strip(), timeout=30)
        except (subprocess.SubprocessError, OSError):
            # Already shut down is harmless; workflow repeats cleanup after failures.
            pass


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if not APP.is_dir():
        raise RuntimeError('Build the simulator app before its smoke check')
    device = select_device(json.loads(simctl('list', 'devices', 'available', '--json')))
    DEVICE_FILE.write_text(device)
    try:
        simctl('bootstatus', device, '-b', timeout=180)
        # Cold CI simulators can need more than 90 seconds to install the extension bundle.
        simctl('install', device, str(APP), timeout=300)
        launch = simctl('launch', device, BUNDLE, timeout=60)
        (OUTPUT / 'launch.txt').write_text(launch)
        match = re.search(r':\s*(\d+)\s*$', launch)
        if not match:
            raise RuntimeError('simctl launch did not report an application process ID')
        pid = int(match[1])
        for _ in range(10):
            time.sleep(1)
            # Simulator application processes run on the macOS host.
            os.kill(pid, 0)
        simctl('io', device, 'screenshot', str(OUTPUT / 'launch.png'), timeout=30)
        (OUTPUT / 'result.txt').write_text(
            'App installed, launch returned a PID, process survived 10 seconds, screenshot captured.\n'
            'No assertions about navigation, data, widgets, pairing or update behavior.\n')
        print('Simulator launch smoke passed; screenshot saved to build/smoke/launch.png')
    except Exception as error:
        (OUTPUT / 'failure.txt').write_text(f'{type(error).__name__}: {error}\n')
        try:
            simctl('io', device, 'screenshot', str(OUTPUT / 'failure.png'), timeout=30)
        except (subprocess.SubprocessError, OSError):
            pass
        raise
    finally:
        shutdown()


if __name__ == '__main__':
    if '--cleanup' in sys.argv:
        shutdown()
    else:
        main()
