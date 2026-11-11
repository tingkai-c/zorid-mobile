"""Capability-report regressions using synthetic plists, never real profiles."""
import base64
import contextlib
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('screen_time_profiles',
                                             Path(__file__).with_name('screen-time-profiles.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
NOW = datetime.datetime(2026, 11, 12, tzinfo=datetime.timezone.utc)


def profile(bundle, **changes):
    value = {
        'UUID': 'PRIVATE-FIXTURE-UUID',
        'Name': 'PRIVATE-FIXTURE-NAME',
        'TeamIdentifier': ['PRIVATE-FIXTURE-TEAM'],
        'ExpirationDate': datetime.datetime(2099, 1, 1),
        'Entitlements': {
            'application-identifier': 'PRIVATE-FIXTURE-TEAM.' + bundle,
            'beta-reports-active': True,
            'get-task-allow': False,
            'com.apple.security.application-groups': [MODULE.APP_GROUP],
            'com.apple.developer.family-controls': True,
        },
    }
    value.update(changes)
    return value


def archive(*profiles):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as zipped:
        for index, value in enumerate(profiles):
            zipped.writestr(f'profiles/{index}.mobileprovision', plistlib.dumps(value))
        zipped.writestr('ignored.txt', 'not a profile')
    return base64.b64encode(output.getvalue()).decode('ascii')


def inspect(encoded):
    return MODULE.inspect_profiles(encoded, decode=plistlib.loads, now=NOW)


class ProfileReportingTests(unittest.TestCase):
    def test_ready_requires_all_five_entitled_distribution_profiles(self):
        receipt = inspect(archive(*(profile(bundle) for bundle in MODULE.BUNDLES)))
        self.assertTrue(receipt['ready'])
        self.assertEqual(receipt['checkState'], 'CHECKED')
        self.assertEqual(set(receipt['profiles']), set(MODULE.BUNDLES))
        for flags in receipt['profiles'].values():
            self.assertEqual(flags, {'present': True, 'familyControls': True, 'appGroup': True,
                                     'distribution': True, 'expired': False})
        serialized = json.dumps(receipt)
        self.assertNotIn('PRIVATE-FIXTURE', serialized)
        self.assertNotIn('ExpirationDate', serialized)
        self.assertNotIn('Entitlements', serialized)

    def test_either_missing_shield_profile_prevents_readiness(self):
        for missing in MODULE.BUNDLES[-2:]:
            with self.subTest(missing=missing):
                receipt = inspect(archive(*(profile(bundle) for bundle in MODULE.BUNDLES if bundle != missing)))
                self.assertFalse(receipt['ready'])
                self.assertFalse(receipt['profiles'][missing]['present'])

    def test_current_two_target_archive_stays_unready_without_exposing_metadata(self):
        first = profile(MODULE.BUNDLES[0])
        first['Entitlements'].pop('com.apple.developer.family-controls')
        receipt = inspect(archive(first, profile(MODULE.BUNDLES[1])))
        self.assertFalse(receipt['ready'])
        self.assertFalse(receipt['profiles'][MODULE.BUNDLES[0]]['familyControls'])
        self.assertFalse(receipt['profiles'][MODULE.BUNDLES[2]]['present'])
        self.assertIsNone(receipt['profiles'][MODULE.BUNDLES[2]]['expired'])

    def test_missing_secret_is_a_completed_unready_check(self):
        receipt = inspect('')
        self.assertFalse(receipt['archivePresent'])
        self.assertFalse(receipt['ready'])
        self.assertEqual(receipt['checkState'], 'CHECKED')

    def test_non_distribution_profiles_are_unready(self):
        for changes in ({'ProvisionedDevices': []}, {'ProvisionedDevices': ['PRIVATE-DEVICE']},
                        {'ProvisionsAllDevices': True}):
            with self.subTest(changes=changes):
                receipt = inspect(archive(profile(MODULE.BUNDLES[0], **changes)))
                self.assertFalse(receipt['profiles'][MODULE.BUNDLES[0]]['distribution'])
                self.assertNotIn('PRIVATE-DEVICE', json.dumps(receipt))
        for key, value in (('get-task-allow', True), ('beta-reports-active', False)):
            candidate = profile(MODULE.BUNDLES[0])
            candidate['Entitlements'][key] = value
            self.assertFalse(inspect(archive(candidate))['profiles'][MODULE.BUNDLES[0]]['distribution'])

    def test_missing_group_and_non_boolean_entitlement_do_not_pass(self):
        candidate = profile(MODULE.BUNDLES[0])
        candidate['Entitlements']['com.apple.developer.family-controls'] = 1
        candidate['Entitlements']['com.apple.security.application-groups'] = ['other-group']
        flags = inspect(archive(candidate))['profiles'][MODULE.BUNDLES[0]]
        self.assertFalse(flags['familyControls'])
        self.assertFalse(flags['appGroup'])

    def test_expiration_boundary_is_inclusive(self):
        candidate = profile(MODULE.BUNDLES[0], ExpirationDate=NOW.replace(tzinfo=None))
        self.assertTrue(inspect(archive(candidate))['profiles'][MODULE.BUNDLES[0]]['expired'])

    def test_duplicates_and_malformed_inputs_fail_with_fixed_codes(self):
        candidate = profile(MODULE.BUNDLES[0])
        with self.assertRaisesRegex(MODULE.ProfileCheckError, '^DUPLICATE_TARGET_PROFILE$'):
            inspect(archive(candidate, candidate))
        for encoded in ('not base64 PRIVATE-DATA', base64.b64encode(b'not a zip').decode()):
            with self.subTest(encoded=encoded), self.assertRaisesRegex(
                    MODULE.ProfileCheckError, '^INVALID_ARCHIVE$'):
                inspect(encoded)
        with self.assertRaisesRegex(MODULE.ProfileCheckError, '^INVALID_PROFILE$'):
            inspect(archive({'Entitlements': {}}))

    def test_archive_size_and_member_limits_bound_decoding(self):
        with patch.object(MODULE, 'MAX_ARCHIVE_BYTES', 1):
            with self.assertRaisesRegex(MODULE.ProfileCheckError, '^INVALID_ARCHIVE$'):
                inspect(archive(profile(MODULE.BUNDLES[0])))
        with patch.object(MODULE, 'MAX_PROFILE_BYTES', 1):
            with self.assertRaisesRegex(MODULE.ProfileCheckError, '^INVALID_ARCHIVE$'):
                inspect(archive(profile(MODULE.BUNDLES[0])))
        with self.assertRaisesRegex(MODULE.ProfileCheckError, '^INVALID_ARCHIVE$'):
            inspect(archive(*(profile(MODULE.BUNDLES[0]) for _ in range(33))))

    def test_decoder_uses_private_files_and_removes_them_on_failure(self):
        seen = []

        def fail(args, **kwargs):
            path = Path(args[-1])
            seen.append(path)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertTrue(kwargs['capture_output'])
            self.assertEqual(path.read_bytes(), b'PRIVATE-PROFILE')
            return subprocess.CompletedProcess(args, 1, stdout=b'', stderr=b'PRIVATE-ERROR')

        with patch.object(MODULE.subprocess, 'run', side_effect=fail):
            with self.assertRaisesRegex(MODULE.ProfileCheckError, '^PROFILE_DECODE_FAILED$'):
                MODULE.decode_profile(b'PRIVATE-PROFILE')
        self.assertEqual(len(seen), 1)
        self.assertFalse(seen[0].parent.exists())

    def test_main_reports_only_fixed_failure_and_retains_safe_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt_path = Path(directory) / 'receipt.json'
            env = {'IOS_APP_STORE_PROFILES_ZIP_BASE64': 'PRIVATE-INVALID-DATA',
                   'SCREEN_TIME_PROFILE_RECEIPT_PATH': str(receipt_path)}
            output = io.StringIO()
            with patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(output):
                self.assertEqual(MODULE.main(), 1)
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt['checkState'], 'INVALID_ARCHIVE')
            self.assertNotIn('PRIVATE', output.getvalue())
            self.assertEqual(json.loads(output.getvalue()), receipt)
            for error in (RuntimeError('PRIVATE-EXCEPTION'), MODULE.ProfileCheckError('PRIVATE-EXCEPTION')):
                with self.subTest(error=type(error)), patch.dict(os.environ, env, clear=True), patch.object(
                        MODULE, 'inspect_profiles', side_effect=error):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        self.assertEqual(MODULE.main(), 1)
                    self.assertEqual(json.loads(output.getvalue())['checkState'], 'PROFILE_CHECK_FAILED')
                    self.assertNotIn('PRIVATE', output.getvalue())


if __name__ == '__main__':
    unittest.main()
