"""Add test-only entitlements to an existing simulator build on a macOS runner.

No certificate, provisioning profile or developer account is used. These bundles
remain simulator-only and cannot be installed on a physical iPhone.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import struct
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

GROUP = 'group.app.zorid.mobile'
TEAM = 'ZORIDTEST0'


def verify_run(run, jobs, run_id, repository):
    if (not re.fullmatch(r'[1-9][0-9]*', str(run_id))
            or run.get('id') != int(run_id)
            or run.get('repository', {}).get('full_name') != repository
            or run.get('path') != '.github/workflows/ios.yml'
            or run.get('status') != 'completed'
            or not re.fullmatch(r'[a-f0-9]{40}', run.get('head_sha', ''))):
        raise ValueError('Expected a completed Build iOS run from this repository')
    if not any(step.get('name') == 'Compile and package' and step.get('conclusion') == 'success'
               for job in jobs.get('jobs', []) for step in job.get('steps', [])):
        raise ValueError('The source run did not successfully compile and package an app')
    return {'run': str(run_id), 'commit': run['head_sha'],
            'artifact': f"zorid-simulator-{int(run['run_number'])}"}


def verify_artifact(directory, source):
    directory = Path(directory)
    fields = {}
    for line in (directory / 'build-info.txt').read_text().splitlines():
        key, separator, value = line.partition(': ')
        if not separator or key in fields:
            raise ValueError('Invalid build receipt')
        fields[key] = value
    if (fields.get('Mode') != 'simulator' or fields.get('Run') != source['run']
            or fields.get('Commit') != source['commit']):
        raise ValueError('Simulator receipt differs from the source run')
    entries = (directory / 'SHA256SUMS').read_text().splitlines()
    if len(entries) != 1:
        raise ValueError('Expected one simulator archive checksum')
    match = re.fullmatch(r'([a-f0-9]{64})  \./Zorid-simulator\.zip', entries[0])
    if not match:
        raise ValueError('Invalid simulator archive checksum')
    with (directory / 'Zorid-simulator.zip').open('rb') as archive:
        digest = hashlib.file_digest(archive, 'sha256').hexdigest()
    if digest != match[1]:
        raise ValueError('Simulator archive checksum mismatch')


def simulator_macho(data):
    """Require every architecture to explicitly target PLATFORM_IOSSIMULATOR."""
    if data[:4] in (b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
        if len(data) < 8:
            raise ValueError('Truncated universal Mach-O header')
        wide = data[:4] == b'\xca\xfe\xba\xbf'
        count = struct.unpack_from('>I', data, 4)[0]
        entry_size = 32 if wide else 20
        if not 1 <= count <= 8 or 8 + count * entry_size > len(data):
            raise ValueError('Invalid universal Mach-O')
        for index in range(count):
            start = 8 + index * entry_size
            offset, size = struct.unpack_from('>QQ' if wide else '>II', data, start + 8)
            if offset < 8 + count * entry_size or not size or offset + size > len(data):
                raise ValueError('Invalid Mach-O slice')
            simulator_macho(data[offset:offset + size])
        return
    formats = {b'\xcf\xfa\xed\xfe': ('<', 32), b'\xce\xfa\xed\xfe': ('<', 28),
               b'\xfe\xed\xfa\xcf': ('>', 32), b'\xfe\xed\xfa\xce': ('>', 28)}
    if data[:4] not in formats:
        raise ValueError('Expected a Mach-O executable')
    endian, header_size = formats[data[:4]]
    if len(data) < header_size:
        raise ValueError('Truncated Mach-O header')
    count, size = struct.unpack_from(endian + 'II', data, 16)
    end = header_size + size
    if count > 4096 or end > len(data):
        raise ValueError('Invalid Mach-O commands')
    position, platforms = header_size, []
    for _ in range(count):
        if position + 8 > end:
            raise ValueError('Truncated Mach-O command')
        command, size = struct.unpack_from(endian + 'II', data, position)
        if size < 8 or position + size > end:
            raise ValueError('Invalid Mach-O command size')
        if command == 0x32:  # LC_BUILD_VERSION
            if size < 24:
                raise ValueError('Invalid build-version command')
            platforms.append(struct.unpack_from(endian + 'I', data, position + 8)[0])
        position += size
    if position != end or platforms != [7]:
        raise ValueError('Refusing a device, macOS or unknown-platform executable')


def bundle_info(bundle):
    info = plistlib.loads((bundle / 'Info.plist').read_bytes())
    executable = info.get('CFBundleExecutable', '')
    identifier = info.get('CFBundleIdentifier', '')
    if (not executable or Path(executable).name != executable
            or not re.fullmatch(r'[A-Za-z0-9.-]+', identifier)):
        raise ValueError('Invalid bundle identity')
    simulator_macho((bundle / executable).read_bytes())
    return identifier


def entitlements(identifier):
    if identifier != 'app.zorid.mobile' and not identifier.startswith('app.zorid.mobile.'):
        raise ValueError('Expected a Zorid application or extension')
    app_id = f'{TEAM}.{identifier}'
    return {'application-identifier': app_id, 'com.apple.developer.team-identifier': TEAM,
            'keychain-access-groups': [app_id], 'com.apple.security.application-groups': [GROUP],
            'com.apple.developer.family-controls': True, 'get-task-allow': True}


def configure_updates(app, origin, certificate, invoke=subprocess.run):
    """Embed public test-host trust, never pairing credentials or private keys."""
    if not origin and not certificate:
        return
    parsed = urlsplit(origin)
    if (not origin or not certificate or parsed.scheme != 'https' or not parsed.hostname
            or parsed.username or parsed.password or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise ValueError('Provide an HTTPS origin and its public update certificate together')
    certificate = certificate.strip() + '\n'
    if not re.fullmatch(r'-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\r\n]+\n-----END CERTIFICATE-----\n', certificate):
        raise ValueError('Expected one public PEM certificate')
    invoke(['openssl', 'x509', '-noout'], input=certificate.encode(), check=True, capture_output=True)
    path = app / 'Expo.plist'
    values = plistlib.loads(path.read_bytes())
    values.update({'EXUpdatesURL': origin.rstrip('/') + '/updates',
                   'EXUpdatesCodeSigningCertificate': certificate, 'EXUpdatesEnabled': True,
                   'EXUpdatesCheckOnLaunch': 'ALWAYS', 'EXUpdatesLaunchWaitMs': 60000,
                   'EXUpdatesCodeSigningMetadata': {'keyid': 'main', 'alg': 'rsa-v1_5-sha256'},
                   'EXUpdatesRequestHeaders': {'Authorization': 'Bearer unpaired'}})
    path.write_bytes(plistlib.dumps(values))


def sign_app(app, invoke=subprocess.run, update_origin='', update_certificate=''):
    app = Path(app).resolve()
    if app.name != 'Zorid.app' or not app.is_dir() or any(app.rglob('embedded.mobileprovision')):
        raise ValueError('Expected an unprovisioned Zorid simulator app')
    frameworks = sorted((p for p in app.rglob('*.framework') if not p.is_symlink()),
                        key=lambda p: (-len(p.parts), str(p)))
    extensions = sorted((app / 'PlugIns').glob('*.appex'))
    targets = [*frameworks, *extensions, app]
    identities = {p: bundle_info(p) for p in targets}  # Validate everything before mutation.
    if identities[app] != 'app.zorid.mobile':
        raise ValueError('Unexpected main application identifier')
    settings = {p: entitlements(identities[p]) for p in [*extensions, app]}
    configure_updates(app, update_origin, update_certificate, invoke)
    with tempfile.TemporaryDirectory(prefix='zorid-simulator-entitlements-') as directory:
        for index, target in enumerate(targets):
            command = ['codesign', '--force', '--sign', '-', '--timestamp=none']
            if target in settings:
                path = Path(directory) / f'{index}.plist'
                path.write_bytes(plistlib.dumps(settings[target]))
                command += ['--entitlements', str(path), '--generate-entitlement-der']
            invoke([*command, str(target)], check=True, capture_output=True)
        invoke(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
        for target, expected in settings.items():
            result = invoke(['codesign', '--display', '--entitlements', '-', '--xml', str(target)],
                            check=True, capture_output=True)
            if plistlib.loads(result.stdout) != expected:
                raise ValueError('Signed simulator entitlements differ from requested values')
    return {'simulatorOnly': True, 'signing': 'ad-hoc', 'appGroup': GROUP,
            'targets': [identities[p] for p in [*extensions, app]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    source = commands.add_parser('source')
    source.add_argument('--run-id', required=True)
    source.add_argument('--repository', required=True)
    source.add_argument('--out', required=True, type=Path)
    verify = commands.add_parser('verify')
    verify.add_argument('directory', type=Path)
    verify.add_argument('--source', required=True, type=Path)
    sign = commands.add_parser('sign')
    sign.add_argument('app', type=Path)
    sign.add_argument('--receipt', required=True, type=Path)
    sign.add_argument('--update-origin', default='')
    sign.add_argument('--update-certificate-pem', default='')
    args = parser.parse_args()
    if args.command == 'source':
        if not re.fullmatch(r'[1-9][0-9]*', args.run_id) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
            raise ValueError('Invalid source run or repository')
        endpoint = f'repos/{args.repository}/actions/runs/{args.run_id}'
        read = lambda path: json.loads(subprocess.run(['gh', 'api', path], check=True, capture_output=True).stdout)
        result = verify_run(read(endpoint), read(endpoint + '/jobs?per_page=100'), args.run_id, args.repository)
        args.out.write_text(json.dumps(result) + '\n')
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f"artifact={result['artifact']}\n")
    elif args.command == 'verify':
        verify_artifact(args.directory, json.loads(args.source.read_text()))
    else:
        if sys.platform != 'darwin':
            raise ValueError('Sign simulator bundles with Apple codesign on a macOS runner')
        args.receipt.write_text(json.dumps(sign_app(args.app, update_origin=args.update_origin,
                                                   update_certificate=args.update_certificate_pem), indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, plistlib.InvalidFileException, struct.error) as error:
        print(f'Simulator packaging failed: {error.__class__.__name__}', file=sys.stderr)
        sys.exit(1)
