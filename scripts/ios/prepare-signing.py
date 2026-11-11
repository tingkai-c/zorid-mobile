"""Decode runner-only secrets; reject mismatched/expired distribution profiles."""
import base64
import datetime
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import zipfile

root = Path(os.environ['RUNNER_TEMP']) / 'zorid-signing'
root.mkdir(mode=0o700, exist_ok=True)
(root / 'certificate.p12').write_bytes(base64.b64decode(os.environ['IOS_CERTIFICATE_P12_BASE64'], validate=True))
team = os.environ['IOS_TEAM_ID']
testflight = os.environ.get('BUILD_MODE') == 'testflight'
profiles = {}
profiles_secret = 'IOS_APP_STORE_PROFILES_ZIP_BASE64' if testflight else 'IOS_PROFILES_ZIP_BASE64'
encoded_profiles = os.environ.get(profiles_secret)
if testflight and not encoded_profiles:
    raise ValueError('TestFlight requires App Store Connect profiles for all five Zorid targets')
if testflight or not encoded_profiles:
    for key in ('ASC_API_KEY_P8_BASE64', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID'):
        if not os.environ.get(key):
            raise ValueError('TestFlight and automatic signing require complete App Store Connect API key secrets')
    (root / 'AuthKey.p8').write_bytes(base64.b64decode(os.environ['ASC_API_KEY_P8_BASE64'], validate=True))
    (root / 'api.json').write_text(json.dumps({'keyId': os.environ['ASC_API_KEY_ID'], 'issuerId': os.environ['ASC_API_ISSUER_ID']}))

if encoded_profiles:
    # Xcode 16+ uses this location; the workflow requires Xcode 27.
    destination = Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles'
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(encoded_profiles, validate=True))) as archive:
        for member in archive.infolist():
            if not member.filename.endswith('.mobileprovision'):
                continue
            raw = archive.read(member)
            temporary = root / 'profile.mobileprovision'
            temporary.write_bytes(raw)
            decoded = subprocess.run(['security', 'cms', '-D', '-i', str(temporary)], capture_output=True, check=True)
            profile = plistlib.loads(decoded.stdout)
            entitlements = profile['Entitlements']
            if entitlements.get('com.apple.developer.family-controls') is not True:
                raise ValueError('Screen Time requires approved Family Controls distribution profiles for every target')
            if team not in profile['TeamIdentifier']:
                raise ValueError('Profile team mismatch')
            if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
                raise ValueError('Provisioning profile expired')
            if testflight:
                if ('ProvisionedDevices' in profile or profile.get('ProvisionsAllDevices')
                        or entitlements.get('get-task-allow') or not entitlements.get('beta-reports-active')):
                    raise ValueError('TestFlight requires App Store Connect distribution profiles')
                if 'group.app.zorid.mobile' not in entitlements.get('com.apple.security.application-groups', []):
                    raise ValueError('TestFlight profile is missing the Zorid App Group')
            elif not profile.get('ProvisionedDevices') or entitlements.get('get-task-allow'):
                raise ValueError('Expected registered-device distribution profiles')
            application_id = entitlements['application-identifier']
            bundle = application_id.split('.', 1)[1]
            if '*' in bundle or bundle in profiles:
                raise ValueError('Each target needs a unique explicit profile')
            uuid = profile['UUID']
            if not all(c in '0123456789abcdefABCDEF-' for c in uuid):
                raise ValueError('Invalid profile UUID')
            path = destination / (uuid + '.mobileprovision')
            path.write_bytes(raw)
            with (root / 'installed-profiles').open('a') as installed:
                installed.write(str(path) + '\n')
            profiles[bundle] = uuid
    if not profiles:
        raise ValueError('No profiles in archive')
    options = {'method': 'app-store-connect' if testflight else 'release-testing',
               'signingStyle': 'manual', 'teamID': team,
               'signingCertificate': 'Apple Distribution', 'provisioningProfiles': profiles}
else:
    options = {'method': 'release-testing', 'signingStyle': 'automatic', 'teamID': team}
if testflight:
    if set(profiles) != {'app.zorid.mobile', 'app.zorid.mobile.widgets', 'app.zorid.mobile.focus-monitor',
                         'app.zorid.mobile.shield-configuration', 'app.zorid.mobile.shield-action'}:
        raise ValueError('TestFlight requires exactly the five Zorid app and extension profiles')
    options.update(destination='upload', testFlightInternalTestingOnly=True, manageAppVersionAndBuildNumber=False)
(root / 'ExportOptions.plist').write_bytes(plistlib.dumps(options))
(root / 'profiles.json').write_text(json.dumps({'team': team, 'profiles': profiles}))
