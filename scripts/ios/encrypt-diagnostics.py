"""Encrypt signing logs to a supplied public recipient certificate before upload."""
import base64
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile


def encrypt_logs(encoded_certificate):
    logs = [path for path in (Path('build/signing-build.log'), Path('build/signing-export.log')) if path.is_file()]
    if not encoded_certificate or not logs:
        print('Encrypted diagnostics skipped: no recipient certificate or signing logs.')
        return
    certificate = base64.b64decode(encoded_certificate, validate=True)
    if b'-----BEGIN CERTIFICATE-----' not in certificate or b'PRIVATE KEY' in certificate:
        raise ValueError('Diagnostics recipient must be a public PEM certificate')
    with tempfile.TemporaryDirectory(prefix='zorid-diagnostics-', dir=os.environ['RUNNER_TEMP']) as directory:
        directory = Path(directory)
        recipient = directory / 'recipient.pem'
        recipient.write_bytes(certificate)
        archive = directory / 'logs.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for path in logs:
                bundle.add(path, arcname=path.name)
        # Capture errors rather than echoing certificate details to the public job log.
        result = subprocess.run([
            'openssl', 'cms', '-encrypt', '-binary', '-aes256', '-in', str(archive),
            '-outform', 'DER', '-out', 'build/private-diagnostics.cms', str(recipient),
        ], capture_output=True)
        if result.returncode:
            Path('build/private-diagnostics.cms').unlink(missing_ok=True)
            raise RuntimeError('Diagnostic encryption failed; no plaintext artifact will be uploaded')
    print('Signing diagnostics encrypted for the configured recipient.')


if __name__ == '__main__':
    encrypt_logs(os.environ.get('ZORID_DIAGNOSTIC_CERTIFICATE_BASE64', ''))
