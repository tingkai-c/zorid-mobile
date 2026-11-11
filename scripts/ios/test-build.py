"""Exercise archive/export shell paths without Xcode, certificates or network.

Run with BASH_BINARY=/bin/bash on macOS to cover Apple's Bash 3.2.
"""
import base64
import datetime
import gzip
import io
import json
import os
from pathlib import Path
import plistlib
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

BUILD_SCRIPT = Path(__file__).with_name('build.sh').resolve()
PREPARE_SCRIPT = BUILD_SCRIPT.with_name('prepare-signing.py')
FAKE_XCODEBUILD = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
with open(os.environ['MOCK_CALLS'], 'a') as output:
    output.write(json.dumps(sys.argv[1:]) + '\\n')
if '-exportArchive' in sys.argv and os.environ['BUILD_MODE'] == 'device':
    destination = Path(sys.argv[sys.argv.index('-exportPath') + 1])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'Zorid.ipa').write_bytes(b'fixture-ipa')
'''


class ArchiveSigningTests(unittest.TestCase):
    def test_manual_and_automatic_archive_export(self):
        for mode, api in (('device', False), ('device', True), ('testflight', True)):
            with self.subTest(mode=mode, api=api), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'ios/Zorid.xcworkspace').mkdir(parents=True)
                signing = root / 'runner/zorid-signing'
                signing.mkdir(parents=True)
                (signing / 'ExportOptions.plist').write_text('fixture')
                if api:
                    (signing / 'api.json').write_text(json.dumps({'keyId': 'TESTKEY', 'issuerId': 'TESTISSUER'}))
                    (signing / 'AuthKey.p8').write_text('fixture, not a key')
                binary = root / 'bin'
                binary.mkdir()
                mock = binary / 'xcodebuild'
                mock.write_text(FAKE_XCODEBUILD)
                mock.chmod(0o755)
                calls_path = root / 'calls.jsonl'
                env = dict(os.environ, BUILD_MODE=mode, RUNNER_TEMP=str(root / 'runner'),
                           GITHUB_RUN_NUMBER='15',
                           MOCK_CALLS=str(calls_path), PATH=str(binary) + os.pathsep + os.environ['PATH'])
                result = subprocess.run([os.environ.get('BASH_BINARY', 'bash'), str(BUILD_SCRIPT)],
                                        cwd=root, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = [json.loads(line) for line in calls_path.read_text().splitlines()]
                self.assertEqual(len(calls), 2)
                self.assertIn('archive', calls[0])
                self.assertIn('-exportArchive', calls[1])
                for index, args in enumerate(calls):
                    authenticated = api and (mode == 'device' or index == 1)
                    self.assertEqual('-allowProvisioningUpdates' in args, authenticated)
                    self.assertEqual('-authenticationKeyPath' in args, authenticated)
                    if authenticated:
                        self.assertEqual(args[args.index('-authenticationKeyID') + 1], 'TESTKEY')
                        self.assertEqual(args[args.index('-authenticationKeyIssuerID') + 1], 'TESTISSUER')
                artifacts = root / 'build/artifacts'
                if mode == 'device':
                    self.assertEqual((artifacts / 'Zorid.ipa').read_bytes(), b'fixture-ipa')
                    self.assertIn('Zorid.ipa', (artifacts / 'SHA256SUMS').read_text())
                else:
                    self.assertEqual(list(artifacts.iterdir()), [artifacts / 'build-info.txt'])
                    self.assertIn('Build: 15\nUpload: internal TestFlight', (artifacts / 'build-info.txt').read_text())


class TestFlightProfileTests(unittest.TestCase):
    @staticmethod
    def encoded_profiles(*, devices=False, widget=True, monitor=True, family=True, shield_config=True, shield_action=True):
        buffer = io.BytesIO()
        bundles = ('app.zorid.mobile', 'app.zorid.mobile.widgets') if widget else ('app.zorid.mobile',)
        if monitor:
            bundles += ('app.zorid.mobile.focus-monitor',)
        if shield_config:
            bundles += ('app.zorid.mobile.shield-configuration',)
        if shield_action:
            bundles += ('app.zorid.mobile.shield-action',)
        with zipfile.ZipFile(buffer, 'w') as archive:
            for index, bundle in enumerate(bundles):
                profile = {
                    'UUID': f'AAAAAAAA-AAAA-AAAA-AAAA-{index:012}',
                    'TeamIdentifier': ['TEAM'],
                    'ExpirationDate': datetime.datetime(2099, 1, 1),
                    'Entitlements': {
                        'application-identifier': f'TEAM.{bundle}',
                        'beta-reports-active': True,
                        'get-task-allow': False,
                        'com.apple.security.application-groups': ['group.app.zorid.mobile'],
                        'com.apple.developer.family-controls': family,
                    },
                }
                if devices:
                    profile['ProvisionedDevices'] = ['fixture-device']
                archive.writestr(f'{index}.mobileprovision', plistlib.dumps(profile))
        return base64.b64encode(buffer.getvalue()).decode('ascii')

    def test_prepare_internal_upload_uses_app_store_profiles(self):
        cases = (
            ('accepted', self.encoded_profiles(), None),
            ('gzip accepted', base64.b64encode(gzip.compress(base64.b64decode(self.encoded_profiles()))).decode('ascii'), None),
            ('ad hoc', self.encoded_profiles(devices=True), 'requires App Store Connect distribution profiles'),
            ('missing widget', self.encoded_profiles(widget=False), 'requires exactly the five Zorid'),
            ('missing monitor', self.encoded_profiles(monitor=False), 'requires exactly the five Zorid'),
            ('missing shield config', self.encoded_profiles(shield_config=False), 'requires exactly the five Zorid'),
            ('missing shield action', self.encoded_profiles(shield_action=False), 'requires exactly the five Zorid'),
            ('missing entitlement', self.encoded_profiles(family=False), 'requires approved Family Controls'),
            ('missing secret', '', 'requires App Store Connect profiles for all five Zorid'),
        )
        for description, profiles, error in cases:
            with self.subTest(description=description), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fake_secret = base64.b64encode(b'fixture, not a credential').decode('ascii')
                env = {
                    'BUILD_MODE': 'testflight',
                    'RUNNER_TEMP': str(root / 'runner'),
                    'IOS_TEAM_ID': 'TEAM',
                    'IOS_CERTIFICATE_P12_BASE64': fake_secret,
                    'IOS_APP_STORE_PROFILES_ZIP_BASE64': profiles,
                    'IOS_PROFILES_ZIP_BASE64': self.encoded_profiles(devices=True),
                    'ASC_API_KEY_P8_BASE64': fake_secret,
                    'ASC_API_KEY_ID': 'TESTKEY',
                    'ASC_API_ISSUER_ID': 'TESTISSUER',
                }
                (root / 'runner').mkdir()

                def decode_profile(args, **kwargs):
                    self.assertEqual(args[:4], ['security', 'cms', '-D', '-i'])
                    return subprocess.CompletedProcess(args, 0, stdout=Path(args[-1]).read_bytes())

                with patch.dict(os.environ, env, clear=True), patch.object(Path, 'home', return_value=root):
                    with patch.object(subprocess, 'run', side_effect=decode_profile):
                        if error:
                            with self.assertRaisesRegex(ValueError, error):
                                runpy.run_path(str(PREPARE_SCRIPT))
                            continue
                        runpy.run_path(str(PREPARE_SCRIPT))
                signing = root / 'runner/zorid-signing'
                options = plistlib.loads((signing / 'ExportOptions.plist').read_bytes())
                self.assertEqual(options['method'], 'app-store-connect')
                self.assertEqual(options['destination'], 'upload')
                self.assertTrue(options['testFlightInternalTestingOnly'])
                self.assertFalse(options['manageAppVersionAndBuildNumber'])
                self.assertEqual(set(options['provisioningProfiles']), {'app.zorid.mobile', 'app.zorid.mobile.widgets',
                    'app.zorid.mobile.focus-monitor', 'app.zorid.mobile.shield-configuration', 'app.zorid.mobile.shield-action'})
                self.assertEqual(json.loads((signing / 'api.json').read_text())['keyId'], 'TESTKEY')


if __name__ == '__main__':
    unittest.main()
