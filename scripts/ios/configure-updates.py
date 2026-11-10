"""Install the public update trust anchor without interpolating workflow inputs."""
import base64
import os
from pathlib import Path
from urllib.parse import urlparse

url = os.environ.get('ZORID_UPDATE_URL', '')
certificate = os.environ.get('ZORID_UPDATE_CERTIFICATE_BASE64', '')
if bool(url) != bool(certificate):
    raise ValueError('Configure both public update URL and public certificate variables, or neither')
if url and certificate:
    if '\n' in url or '\r' in url or urlparse(url).scheme != 'https':
        raise ValueError('Update URL must be a single HTTPS URL')
    decoded = base64.b64decode(certificate, validate=True)
    if b'-----BEGIN CERTIFICATE-----' not in decoded or b'PRIVATE KEY' in decoded:
        raise ValueError('Update trust anchor must contain only a public PEM certificate')
    path = Path(os.environ['RUNNER_TEMP']) / 'zorid-update-certificate.pem'
    path.write_bytes(decoded)
    with open(os.environ['GITHUB_ENV'], 'a') as output:
        output.write(f'ZORID_UPDATE_URL={url}\nZORID_UPDATE_CERTIFICATE={path}\n')
