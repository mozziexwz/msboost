#!/usr/bin/env python3
import hashlib
import io
import os
import platform
import sys
import tarfile
import urllib.request
from pathlib import Path
from assets import release_asset

def main():
    target = Path(sys.argv[1])
    if str(target) != '/usr/local/lib/msboostgost/msboostgost':
        raise SystemExit('Only the dedicated MSBOOST binary target is allowed')
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    if not architecture:
        raise SystemExit('Unsupported architecture')
    version = 'v3.2.6'
    url, digest = release_asset('go-gost/gost', version, [f'gost_{version[1:]}_linux_{architecture}.tar.gz', f'gost_{version[1:]}_linux_{architecture}v1.tar.gz'])
    with urllib.request.urlopen(url, timeout=120) as response:
        blob = response.read(80 * 1024 * 1024)
    if hashlib.sha256(blob).hexdigest() != digest:
        raise SystemExit('Checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as archive:
        member = archive.getmember('gost')
        if not member.isfile() or member.size > 200 * 1024 * 1024:
            raise SystemExit('Invalid binary archive')
        data = archive.extractfile(member).read()
    temporary = target.with_suffix('.new')
    temporary.write_bytes(data)
    os.chmod(temporary, 0o755)
    os.replace(temporary, target)

if __name__ == '__main__':
    main()
