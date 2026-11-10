"""Mock simulator failure paths without requiring an Apple runtime."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).with_name('simulator-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        smoke.OUTPUT = Path(self.directory.name) / 'smoke'
        smoke.DEVICE_FILE = smoke.OUTPUT / 'device-id.txt'
        smoke.APP = Path(self.directory.name) / 'app'
        smoke.APP.mkdir()

    def test_install_timeout_captures_failure_screenshot_and_shuts_down(self):
        def invoke(*args, **kwargs):
            if args[0] == 'list':
                return '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"name":"iPhone 18","udid":"TEST","isAvailable":true}]}}'
            if args[0] == 'install':
                self.assertEqual(kwargs['timeout'], 300)
                raise subprocess.TimeoutExpired('install', 300)
            return ''
        with patch.object(smoke, 'simctl', side_effect=invoke) as command:
            with self.assertRaises(subprocess.TimeoutExpired):
                smoke.main()
            self.assertEqual(command.call_args.args, ('shutdown', 'TEST'))
            self.assertTrue(any(call.args[:3] == ('io', 'TEST', 'screenshot') for call in command.call_args_list))
        self.assertIn('TimeoutExpired', (smoke.OUTPUT / 'failure.txt').read_text())

    def test_timeout_logs_partial_output(self):
        failure = subprocess.TimeoutExpired('simctl', 300, output=b'partial stdout', stderr=b'install diagnostic')
        with patch.object(smoke.subprocess, 'run', side_effect=failure):
            with self.assertRaises(subprocess.TimeoutExpired):
                smoke.simctl('install', 'TEST', 'app', timeout=300)
        log = (smoke.OUTPUT / 'simctl.log').read_text()
        self.assertIn('partial stdout', log)
        self.assertIn('install diagnostic', log)


if __name__ == '__main__':
    unittest.main()
