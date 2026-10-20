#!/usr/bin/env python3
"""Build a reproducible standalone MCP candidate from reviewed committed files."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def build(output, target):
    if git('status', '--porcelain').strip():
        raise RuntimeError('Commit the reviewed source before packaging a candidate.')
    commit = git('rev-parse', 'HEAD').decode().strip()
    names = git('show', 'HEAD:installer/fleetV2/SOURCE-ALLOWLIST').decode().splitlines()
    if names != sorted(set(names)) or not names:
        raise RuntimeError('The source allowlist must be nonempty, sorted and unique.')
    for name in names:
        parts = PurePosixPath(name).parts
        if not parts or name.startswith('/') or '..' in parts or '\\' in name:
            raise RuntimeError('Invalid source path: ' + name)
        if any(part in ('.claude-plugin', '.codex-plugin', 'node_modules', '.git') for part in parts):
            raise RuntimeError('This build accepts standalone MCP source only: ' + name)
    files = {}
    with tarfile.open(fileobj=io.BytesIO(git('archive', 'HEAD', *names))) as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile() or member.name not in names:
                raise RuntimeError('Unexpected archive entry: ' + member.name)
            files['runtime/' + member.name] = archive.extractfile(member).read()
    if len(files) != len(names):
        raise RuntimeError('The committed source does not match the allowlist.')
    metadata = json.loads(files['runtime/fleetV2.json'])
    if metadata['name'] != 'fleetV2' or metadata['distribution'] != 'standalone-mcp':
        raise RuntimeError('Expected standalone fleetV2 metadata.')
    version = metadata['version']
    files['verify.cjs'] = git('show', 'HEAD:installer/fleetV2/verify.cjs')
    files['README.md'] = git('show', 'HEAD:docs/FLEET-V2-SETUP.md')
    manifest = dict(name='fleetV2', version=version, target=target, commit=commit,
                    distribution='standalone-mcp', qualification='development-candidate; see retained platform receipts',
                    files=[dict(path=name, size=len(body), sha256=hashlib.sha256(body).hexdigest())
                           for name, body in sorted(files.items())])
    files['release.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    prefix = f'fleetV2-{version}-{target}'
    artifact = output / (prefix + '.zip')
    with zipfile.ZipFile(artifact, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, body in sorted(files.items()):
            info = zipfile.ZipInfo(prefix + '/' + name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, body)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    (output / (artifact.name + '.sha256')).write_text(f'{digest}  {artifact.name}\n')
    print(json.dumps(dict(file=str(artifact), sha256=digest, commit=commit, files=len(files))))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--target', choices=['linux-x64', 'windows-x64'], required=True)
    args = parser.parse_args()
    build(args.output.resolve(), args.target)
