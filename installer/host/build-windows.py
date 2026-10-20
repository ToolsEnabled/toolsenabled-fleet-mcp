#!/usr/bin/env python3
"""Package the committed native Windows host; no WSL or provider is bundled."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def build(output):
    if git('status', '--porcelain').strip():
        raise RuntimeError('Commit all reviewed files before building.')
    commit = git('rev-parse', 'HEAD').decode().strip()
    names = git('show', 'HEAD:installer/openshell/SOURCE-ALLOWLIST').decode().splitlines()
    assert names == sorted(set(names))
    files = {}
    with tarfile.open(fileobj=io.BytesIO(git('archive', 'HEAD', *names))) as archive:
        for member in archive:
            if member.isdir():
                continue
            assert member.isfile() and member.name in names
            files['runtime/' + member.name] = archive.extractfile(member).read()
    assert len(files) == len(names)
    version = json.loads(files['runtime/package.json'])['version']
    files['install.cjs'] = git('show', 'HEAD:installer/host/windows-install.cjs')
    files['install.cmd'] = b'@echo off\r\nnode "%~dp0install.cjs" %*\r\nexit /b %errorlevel%\r\n'
    files['INSTALL.txt'] = (
        f'ToolsEnabled Fleet {version} — native Windows x64\n\n'
        'Requires Windows 10/11 x64, local NTFS, Windows PowerShell 5.1 and Node.js 22.19 or newer.\n'
        'Provider CLIs are separately installed and signed in under your own account.\n'
        'Authenticate SHA256SUMS from the release channel before extracting or executing code.\n'
        'Extract outside the installation and project folders. Run in your own terminal:\n\n'
        '  install.cmd --workspace "C:\\Users\\YOU\\Projects\\my-project" --enable-workers\n\n'
        'Omit --enable-workers to use coordination only. --root selects an installation folder\n'
        'inside your Windows profile. --tier guided|standard can narrow the Fleet tool surface.\n'
        'Workers strictly inherit the observed parent level, further narrowed by roles and caps.\n'
        'Unknown parents use the conservative fallback. No worker grants itself new permissions.\n'
        'This host runs with your account permissions; it is not an OS security sandbox.\n\n'
        'Setup prints mcpServers JSON. Add that exact entry in your MCP client configuration.\n'
        'It also prints check and uninstall commands. Run those from the installed version.\n'
        'Close all Fleet clients before uninstalling. Uninstall retains state and your project;\n'
        'remove the client registration yourself if you added it. A changed runtime is retained.\n'
        'Use a fresh --root for each installation; existing state is retained and never overwritten.\n'
        'Plugin-specific vendor restrictions are separate distributions and remain enforced there.\n\n'
        'Publication requires native Windows qualification of this exact extracted archive,\n'
        'including worker lifecycle, private ACL refusal, installation and removal.\n'
    ).encode()
    release = dict(name='toolsenabled-fleet', target='windows-x64', version=version,
                   commit=commit, files=[
                       dict(path=name, size=len(body), sha256=hashlib.sha256(body).hexdigest())
                       for name, body in sorted(files.items())])
    files['release.json'] = (json.dumps(release, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    prefix = f'toolsenabled-fleet-{version}-windows-x64'
    archive = output / (prefix + '.zip')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as handle:
        for name, body in sorted(files.items()):
            info = zipfile.ZipInfo(prefix + '/' + name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            handle.writestr(info, body)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / 'SHA256SUMS').write_text(f'{digest}  {archive.name}\n')
    print(json.dumps(dict(file=str(archive), sha256=digest, commit=commit,
                          qualification='pending native Windows exact-artifact gate')))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: build-windows.py OUTPUT_DIRECTORY')
    build(Path(sys.argv[1]).resolve())
