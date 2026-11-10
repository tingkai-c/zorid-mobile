"""Pin signing to the one valid identity in the isolated import keychain."""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess


def identity_fingerprint(output):
    fingerprints = re.findall(r'^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+".*"\s*$', output, re.M)
    counts = re.findall(r'^\s*(\d+) valid identities found\s*$', output, re.M)
    if len(fingerprints) != 1 or counts != ['1']:
        raise ValueError('Expected exactly one valid signing identity in the temporary keychain')
    return fingerprints[0].upper()


def main():
    root = Path(os.environ['RUNNER_TEMP']) / 'zorid-signing'
    keychain = (root / 'keychain-path').read_text().strip()
    result = subprocess.run(['security', 'find-identity', '-v', '-p', 'codesigning', keychain],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Unable to inspect imported signing identity')
    fingerprint = identity_fingerprint(result.stdout)
    settings_path = root / 'profiles.json'
    settings = json.loads(settings_path.read_text())
    settings['signingIdentity'] = fingerprint
    settings_path.write_text(json.dumps(settings))
    options_path = root / 'ExportOptions.plist'
    options = plistlib.loads(options_path.read_bytes())
    options['signingCertificate'] = fingerprint
    options_path.write_bytes(plistlib.dumps(options))
    print('Pinned export to the single imported distribution identity.')


if __name__ == '__main__':
    main()
