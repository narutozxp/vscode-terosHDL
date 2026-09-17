#!/usr/bin/env python3
"""Install pinned upstream binaries; run from any working directory."""
import argparse
import errno
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tool', choices=['ctags', 'verible'])
    parser.add_argument('--cache-dir', type=Path, help='Reuse downloaded archives')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / 'server/binaries.json').read_text())
    assets = [a for a in manifest['assets'] if not args.tool or a['tool'] == args.tool]
    with tempfile.TemporaryDirectory(prefix='zhdl-binaries-') as tmp:
        staged = []
        for index, asset in enumerate(assets):
            name = asset['url'].rsplit('/', 1)[-1]
            archive = args.cache_dir / name if args.cache_dir else Path(tmp) / name
            if not archive.exists():
                archive.parent.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(asset['url'], archive)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != asset['sha256']:
                raise RuntimeError(f'Archive checksum mismatch: {name}')
            if name.endswith('.zip'):
                with zipfile.ZipFile(archive) as package:
                    content = package.read(asset['member'])
            else:
                with tarfile.open(archive) as package:
                    content = package.extractfile(asset['member']).read()
            binary = Path(tmp) / str(index)
            binary.write_bytes(content)
            binary.chmod(0o755)
            staged.append((binary, root / asset['destination']))
        # Download, verify and extract all assets before replacing installed files.
        for binary, destination in staged:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(binary, destination)
            print(f'Installed {destination.relative_to(root)}')
        if any(a['tool'] == 'verible' for a in assets):
            for directory in (root / 'server/verible').iterdir():
                if directory.is_dir() and directory.name != manifest['veribleVersion']:
                    # Only prune obsolete directories containing bundled LS binaries.
                    if all(p.name in ['verible-verilog-ls', 'verible-verilog-ls.exe']
                           and p.is_file() for p in directory.iterdir()):
                        try:
                            shutil.rmtree(directory)
                        except OSError as error:
                            if error.errno != errno.ENOTEMPTY:
                                raise
                            # FUSE may retain an open binary until the editor exits.
                            print(f'Old server still open; cleanup deferred: {directory.name}')


if __name__ == '__main__':
    main()
