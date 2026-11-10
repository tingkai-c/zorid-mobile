"""Exercise archive/export shell paths without Xcode, certificates or network.

Run with BASH_BINARY=/bin/bash on macOS to cover Apple's Bash 3.2.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

BUILD_SCRIPT = Path(__file__).with_name('build.sh').resolve()
FAKE_XCODEBUILD = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
with open(os.environ['MOCK_CALLS'], 'a') as output:
    output.write(json.dumps(sys.argv[1:]) + '\\n')
if '-exportArchive' in sys.argv:
    destination = Path(sys.argv[sys.argv.index('-exportPath') + 1])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'Zorid.ipa').write_bytes(b'fixture-ipa')
'''


class ArchiveSigningTests(unittest.TestCase):
    def test_manual_and_automatic_archive_export(self):
        for automatic in (False, True):
            with self.subTest(automatic=automatic), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'ios/Zorid.xcworkspace').mkdir(parents=True)
                signing = root / 'runner/zorid-signing'
                signing.mkdir(parents=True)
                (signing / 'ExportOptions.plist').write_text('fixture')
                if automatic:
                    (signing / 'api.json').write_text(json.dumps({'keyId': 'TESTKEY', 'issuerId': 'TESTISSUER'}))
                    (signing / 'AuthKey.p8').write_text('fixture, not a key')
                binary = root / 'bin'
                binary.mkdir()
                mock = binary / 'xcodebuild'
                mock.write_text(FAKE_XCODEBUILD)
                mock.chmod(0o755)
                calls_path = root / 'calls.jsonl'
                env = dict(os.environ, BUILD_MODE='device', RUNNER_TEMP=str(root / 'runner'),
                           MOCK_CALLS=str(calls_path), PATH=str(binary) + os.pathsep + os.environ['PATH'])
                result = subprocess.run([os.environ.get('BASH_BINARY', 'bash'), str(BUILD_SCRIPT)],
                                        cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in calls_path.read_text().splitlines()]
                self.assertEqual(len(calls), 2)
                self.assertIn('archive', calls[0])
                self.assertIn('-exportArchive', calls[1])
                for args in calls:
                    self.assertEqual('-allowProvisioningUpdates' in args, automatic)
                    self.assertEqual('-authenticationKeyPath' in args, automatic)
                    if automatic:
                        self.assertEqual(args[args.index('-authenticationKeyID') + 1], 'TESTKEY')
                        self.assertEqual(args[args.index('-authenticationKeyIssuerID') + 1], 'TESTISSUER')
                self.assertEqual((root / 'build/artifacts/Zorid.ipa').read_bytes(), b'fixture-ipa')
                self.assertIn('Zorid.ipa', (root / 'build/artifacts/SHA256SUMS').read_text())


if __name__ == '__main__':
    unittest.main()
