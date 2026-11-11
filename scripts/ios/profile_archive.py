"""Read legacy ZIP or gzip-wrapped ZIP signing inputs without unbounded expansion."""
import base64
import gzip
import io
import zlib


def decode_profile_archive(encoded, maximum=16 * 1024 * 1024):
    try:
        if not isinstance(encoded, str) or len(encoded) > 4 * ((maximum + 2) // 3):
            raise ValueError()
        raw = base64.b64decode(encoded, validate=True)
        if raw.startswith(b'\x1f\x8b'):
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as archive:
                raw = archive.read(maximum + 1)
        if len(raw) > maximum:
            raise ValueError()
        return raw
    except (ValueError, OSError, EOFError, zlib.error):
        raise ValueError('Invalid or oversized signing profile archive') from None
