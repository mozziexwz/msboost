"""Resolve pinned upstream release assets over verified HTTPS and require SHA-256."""
import json
import re
import urllib.request

def release_asset(repository, version, candidates):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', version):
        raise ValueError('A pinned stable version is required')
    url = f'https://api.github.com/repos/{repository}/releases/tags/{version}'
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'MSBOOST/1'})
    with urllib.request.urlopen(request, timeout=20) as response:
        release = json.load(response)
    asset = next((a for name in candidates for a in release.get('assets', []) if a['name'] == name), None)
    if not asset or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or ''):
        raise ValueError('Pinned release asset with SHA-256 digest not available')
    if not asset['browser_download_url'].startswith(f'https://github.com/{repository}/releases/download/{version}/'):
        raise ValueError('Unexpected release URL')
    return asset['browser_download_url'], asset['digest'][7:]
