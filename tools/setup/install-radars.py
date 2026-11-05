"""Opt-in fetch of pinned public game radar assets; no private data is read."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import urllib.request
import zipfile


def install(root: Path, *, accepted: bool) -> int:
    if not accepted:
        raise ValueError('Read THIRD_PARTY_NOTICES.md, then pass --accept-game-assets for your own use')
    folder = root / 'dashboard' / 'assets' / 'radars'
    source = json.loads((folder / 'sources.json').read_text(encoding='utf-8'))
    url = source['source_archive']
    if not url.startswith('https://github.com/pnxenopoulos/awpy-data/releases/download/'):
        raise ValueError('Unexpected pinned asset host')
    request = urllib.request.Request(url, headers={'User-Agent': 'cs2-analyst-template-setup'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != source['source_archive_sha256']:
        raise ValueError('Radar archive checksum mismatch')
    verified = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for metadata in source['assets'].values():
            name = metadata['file']
            if Path(name).name != name or not name.endswith('.png'):
                raise ValueError('Invalid radar filename')
            matches = [item for item in archive.infolist() if Path(item.filename).name == name and not item.is_dir()]
            if len(matches) != 1 or matches[0].file_size > 4 * 1024 * 1024:
                raise ValueError('Radar archive entry mismatch')
            content = archive.read(matches[0])
            if len(content) != metadata['bytes'] or hashlib.sha256(content).hexdigest() != metadata['sha256']:
                raise ValueError('Radar image checksum mismatch')
            verified.append((name, content))
    # Do not overwrite anything until every expected asset passes integrity.
    for name, content in verified:
        (folder / name).write_bytes(content)
    return len(verified)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--accept-game-assets', action='store_true')
    args = parser.parse_args()
    count = install(Path(__file__).resolve().parents[2], accepted=args.accept_game_assets)
    print(json.dumps({'installed_radars': count, 'private_data_accessed': False}))
