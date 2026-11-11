"""Validate simulator-only signing and artifact provenance without Apple tools."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('sign_simulator', Path(__file__).with_name('sign-simulator.py'))
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


def macho(platform=7):
    header = struct.pack('<IiiIIIII', 0xfeedfacf, 0x100000c, 0, 2, 1, 24, 0, 0)
    return header + struct.pack('<IIIIII', 0x32, 24, platform, 0, 0, 0)


def universal(*slices):
    offset = 8 + 20 * len(slices)
    entries = []
    for data in slices:
        entries.append(struct.pack('>IIIII', 0x100000c, 0, offset, len(data), 0))
        offset += len(data)
    return struct.pack('>II', 0xcafebabe, len(slices)) + b''.join(entries) + b''.join(slices)


class SigningTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def bundle(self, path, identifier, platform=7):
        path.mkdir(parents=True)
        (path / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': identifier, 'CFBundleExecutable': 'Binary'}))
        (path / 'Binary').write_bytes(macho(platform))
        return path

    def test_main_and_extension_entitlements_are_distinct_and_share_app_group(self):
        main = signing.entitlements('app.zorid.mobile')
        extension = signing.entitlements('app.zorid.mobile.widgets')
        self.assertEqual(main['application-identifier'], 'ZORIDTEST0.app.zorid.mobile')
        self.assertEqual(extension['application-identifier'], 'ZORIDTEST0.app.zorid.mobile.widgets')
        for value in (main, extension):
            self.assertEqual(value['keychain-access-groups'], [value['application-identifier']])
            self.assertEqual(value['com.apple.security.application-groups'], ['group.app.zorid.mobile'])

    def test_simulator_architectures_only(self):
        for data in (macho(), universal(macho(), macho())):
            signing.simulator_macho(data)
        for data in (macho(2), macho(1), universal(macho(), macho(2)), b'',
                     b'\xca\xfe\xba\xbe', macho()[:40], universal(macho())[:30]):
            with self.subTest(data=data[:8]), self.assertRaises(ValueError):
                signing.simulator_macho(data)

    def test_inside_out_signing_then_verification(self):
        app = self.bundle(self.root / 'Zorid.app', 'app.zorid.mobile')
        extension = self.bundle(app / 'PlugIns' / 'Widget.appex', 'app.zorid.mobile.widgets')
        framework = self.bundle(app / 'Frameworks' / 'React.framework', '-pkg.ZXingObjC')
        nested_framework = self.bundle(extension / 'Frameworks' / 'Shared.framework', 'app.shared')
        calls, signed = [], {}

        def invoke(command, **kwargs):
            self.assertTrue(kwargs['check'])
            calls.append(command)
            if '--sign' in command:
                self.assertEqual(command[command.index('--sign') + 1], '-')
                if '--entitlements' in command:
                    self.assertIn('--generate-entitlement-der', command)
                    signed[command[-1]] = plistlib.loads(Path(command[command.index('--entitlements') + 1]).read_bytes())
                return subprocess.CompletedProcess(command, 0)
            if '--display' in command:
                return subprocess.CompletedProcess(command, 0, stdout=plistlib.dumps(signed[command[-1]]))
            return subprocess.CompletedProcess(command, 0)

        receipt = signing.sign_app(app, invoke)
        targets = [Path(call[-1]) for call in calls if '--sign' in call]
        self.assertEqual(targets, [nested_framework, framework, extension, app])
        self.assertEqual(signed[str(app)], signing.entitlements('app.zorid.mobile'))
        self.assertEqual(signed[str(extension)], signing.entitlements('app.zorid.mobile.widgets'))
        self.assertEqual(calls[4], ['codesign', '--verify', '--deep', '--strict', str(app)])
        self.assertEqual(receipt['targets'], ['app.zorid.mobile.widgets', 'app.zorid.mobile'])
        self.assertTrue(receipt['simulatorOnly'])

    def test_reject_device_extension_before_any_signing(self):
        app = self.bundle(self.root / 'Zorid.app', 'app.zorid.mobile')
        self.bundle(app / 'PlugIns' / 'Widget.appex', 'app.zorid.mobile.widgets', platform=2)
        calls = []
        with self.assertRaises(ValueError):
            signing.sign_app(app, lambda *args, **kwargs: calls.append(args))
        self.assertEqual(calls, [])

    def test_reject_profile_or_foreign_bundle_identity(self):
        app = self.bundle(self.root / 'Zorid.app', 'app.zorid.mobile')
        profile = app / 'embedded.mobileprovision'
        profile.write_bytes(b'test')
        with self.assertRaises(ValueError):
            signing.sign_app(app)
        profile.unlink()
        self.bundle(app / 'PlugIns' / 'Foreign.appex', 'app.foreign')
        with self.assertRaises(ValueError):
            signing.sign_app(app)

    def test_only_public_update_trust_can_be_embedded(self):
        app = self.bundle(self.root / 'Zorid.app', 'app.zorid.mobile')
        (app / 'Expo.plist').write_bytes(plistlib.dumps({'EXUpdatesRuntimeVersion': 'test-runtime'}))
        certificate = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n'
        calls = []
        signing.configure_updates(app, 'https://test.example', certificate,
                                  lambda command, **kwargs: calls.append((command, kwargs)))
        self.assertEqual(calls[0][0], ['openssl', 'x509', '-noout'])
        self.assertEqual(calls[0][1]['input'], certificate.encode())
        values = plistlib.loads((app / 'Expo.plist').read_bytes())
        self.assertEqual(values['EXUpdatesURL'], 'https://test.example/updates')
        self.assertEqual(values['EXUpdatesCodeSigningCertificate'], certificate)
        self.assertEqual(values['EXUpdatesRequestHeaders'], {'Authorization': 'Bearer unpaired'})
        self.assertEqual(values['EXUpdatesCheckOnLaunch'], 'ALWAYS')
        self.assertEqual(values['EXUpdatesRuntimeVersion'], 'test-runtime')
        original = (app / 'Expo.plist').read_bytes()
        for origin, cert in [('http://test.example', certificate), ('https://user:pass@test.example', certificate),
                             ('https://test.example/token', certificate), ('', certificate),
                             ('https://test.example', ''), ('https://test.example', 'PRIVATE KEY')]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                signing.configure_updates(app, origin, cert)
        self.assertEqual((app / 'Expo.plist').read_bytes(), original)


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.run = {'id': 123, 'repository': {'full_name': 'owner/zorid'},
                    'path': '.github/workflows/ios.yml', 'status': 'completed',
                    'conclusion': 'failure', 'head_sha': 'a' * 40, 'run_number': 24}
        self.jobs = {'jobs': [{'steps': [{'name': 'Compile and package', 'conclusion': 'success'}]}]}

    def test_failed_smoke_source_is_usable_when_compile_succeeded(self):
        self.assertEqual(signing.verify_run(self.run, self.jobs, '123', 'owner/zorid'),
                         {'run': '123', 'commit': 'a' * 40, 'artifact': 'zorid-simulator-24'})

    def test_source_must_be_completed_matching_build_run(self):
        for key, value in [('id', 124), ('repository', {'full_name': 'other/repo'}),
                           ('path', '.github/workflows/other.yml'), ('status', 'in_progress'),
                           ('head_sha', 'bad')]:
            run = copy.deepcopy(self.run)
            run[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                signing.verify_run(run, self.jobs, '123', 'owner/zorid')
        for conclusion in ('failure', 'cancelled', 'skipped'):
            jobs = copy.deepcopy(self.jobs)
            jobs['jobs'][0]['steps'][0]['conclusion'] = conclusion
            with self.subTest(conclusion=conclusion), self.assertRaises(ValueError):
                signing.verify_run(self.run, jobs, '123', 'owner/zorid')

    def test_archive_hash_receipt_mode_run_and_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b'simulator zip fixture'
            (root / 'Zorid-simulator.zip').write_bytes(data)
            checksum = hashlib.sha256(data).hexdigest() + '  ./Zorid-simulator.zip\n'
            (root / 'SHA256SUMS').write_text(checksum)
            receipt = f"Commit: {'a' * 40}\nRun: 123\nMode: simulator\n"
            (root / 'build-info.txt').write_text(receipt)
            source = signing.verify_run(self.run, self.jobs, '123', 'owner/zorid')
            signing.verify_artifact(root, source)
            for old, new in [('simulator', 'adhoc'), ('123', '124'), ('a' * 40, 'b' * 40)]:
                (root / 'build-info.txt').write_text(receipt.replace(old, new))
                with self.subTest(field=old), self.assertRaises(ValueError):
                    signing.verify_artifact(root, source)
            (root / 'build-info.txt').write_text(receipt)
            (root / 'Zorid-simulator.zip').write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                signing.verify_artifact(root, source)
            (root / 'SHA256SUMS').write_text(checksum.replace('./Zorid-simulator.zip', '../unsafe.zip'))
            with self.assertRaises(ValueError):
                signing.verify_artifact(root, source)


if __name__ == '__main__':
    unittest.main()
