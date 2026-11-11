"""Report only public-target capability flags from runner-only signing profiles.

This checks profile contents, not the current Apple portal approval state or the
distribution certificate. Missing capabilities may require profile regeneration.
"""
import base64
import binascii
import datetime
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import zipfile

BUNDLES = ('app.zorid.mobile', 'app.zorid.mobile.widgets', 'app.zorid.mobile.focus-monitor',
           'app.zorid.mobile.shield-configuration', 'app.zorid.mobile.shield-action')
APP_GROUP = 'group.app.zorid.mobile'
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_PROFILE_BYTES = 2 * 1024 * 1024
ERROR_CODES = frozenset({'INVALID_ARCHIVE', 'INVALID_PROFILE', 'DUPLICATE_TARGET_PROFILE',
                         'PROFILE_DECODE_FAILED'})


class ProfileCheckError(Exception):
    """An allowlisted error code, never an input-dependent diagnostic."""


def empty_receipt(archive_present=False):
    return {
        'checkState': 'CHECKED',
        'archivePresent': archive_present,
        'ready': False,
        'profiles': {
            bundle: {'present': False, 'familyControls': False, 'appGroup': False,
                     'distribution': False, 'expired': None}
            for bundle in BUNDLES
        },
    }


def decode_profile(raw):
    # No archive paths are extracted. The only plaintext file is private, temporary
    # and removed even when security or plist parsing fails.
    with tempfile.TemporaryDirectory(prefix='zorid-screen-time-') as directory:
        os.chmod(directory, 0o700)
        path = Path(directory) / 'profile.mobileprovision'
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(raw)
        result = subprocess.run(['security', 'cms', '-D', '-i', str(path)],
                                capture_output=True, timeout=30)
        if result.returncode != 0:
            raise ProfileCheckError('PROFILE_DECODE_FAILED')
        try:
            return plistlib.loads(result.stdout)
        except (plistlib.InvalidFileException, ValueError, TypeError):
            raise ProfileCheckError('INVALID_PROFILE') from None


def inspect_profiles(encoded, *, decode=decode_profile, now=None):
    receipt = empty_receipt(bool(encoded))
    if not encoded:
        return receipt
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_ARCHIVE_BYTES + 2) // 3):
        raise ProfileCheckError('INVALID_ARCHIVE')
    try:
        raw = base64.b64decode(encoded, validate=True)
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except (binascii.Error, ValueError, zipfile.BadZipFile):
        raise ProfileCheckError('INVALID_ARCHIVE') from None
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    with archive:
        members = [item for item in archive.infolist()
                   if not item.is_dir() and item.filename.endswith('.mobileprovision')]
        if not members or len(members) > 32 or any(
                item.file_size > MAX_PROFILE_BYTES or item.flag_bits & 1 for item in members):
            raise ProfileCheckError('INVALID_ARCHIVE')
        if sum(item.file_size for item in members) > MAX_ARCHIVE_BYTES:
            raise ProfileCheckError('INVALID_ARCHIVE')
        for member in members:
            profile = decode(archive.read(member))
            if not isinstance(profile, dict) or not isinstance(profile.get('Entitlements'), dict):
                raise ProfileCheckError('INVALID_PROFILE')
            entitlements = profile['Entitlements']
            application_id = entitlements.get('application-identifier')
            if not isinstance(application_id, str) or '.' not in application_id:
                raise ProfileCheckError('INVALID_PROFILE')
            bundle = application_id.split('.', 1)[1]
            if bundle not in receipt['profiles']:
                continue
            if receipt['profiles'][bundle]['present']:
                raise ProfileCheckError('DUPLICATE_TARGET_PROFILE')
            expiration = profile.get('ExpirationDate')
            if not isinstance(expiration, datetime.datetime):
                raise ProfileCheckError('INVALID_PROFILE')
            if expiration.tzinfo is None:
                expiration = expiration.replace(tzinfo=datetime.timezone.utc)
            groups = entitlements.get('com.apple.security.application-groups', [])
            receipt['profiles'][bundle] = {
                'present': True,
                'familyControls': entitlements.get('com.apple.developer.family-controls') is True,
                'appGroup': isinstance(groups, list) and APP_GROUP in groups,
                'distribution': ('ProvisionedDevices' not in profile
                                 and not profile.get('ProvisionsAllDevices')
                                 and not entitlements.get('get-task-allow')
                                 and entitlements.get('beta-reports-active') is True),
                'expired': expiration <= now,
            }
    receipt['ready'] = all(item['present'] and item['familyControls'] and item['appGroup']
                           and item['distribution'] and item['expired'] is False
                           for item in receipt['profiles'].values())
    return receipt


def main():
    encoded = os.environ.get('IOS_APP_STORE_PROFILES_ZIP_BASE64', '')
    code = 0
    try:
        receipt = inspect_profiles(encoded)
    except Exception as error:
        receipt = empty_receipt(bool(encoded))
        receipt['checkState'] = (str(error) if isinstance(error, ProfileCheckError) and str(error) in ERROR_CODES
                                 else 'PROFILE_CHECK_FAILED')
        code = 1
    output = json.dumps(receipt, sort_keys=True)
    destination = os.environ.get('SCREEN_TIME_PROFILE_RECEIPT_PATH')
    if destination:
        Path(destination).write_text(output + '\n')
    print(output)
    return code


if __name__ == '__main__':
    sys.exit(main())
