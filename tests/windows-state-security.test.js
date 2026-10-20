'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = process.env.FLEET_PACKAGED_ENGINE || path.resolve(__dirname, '..');
const fromEngine = name => require(path.join(engine, name));
const { spawnSync } = require('node:child_process');
const security = fromEngine('src/lib/windows-state-security');
const native = { skip: process.platform !== 'win32', timeout: 120000 };

test('native Fleet state has private inherited file ACLs and rejects links and widened entries', native, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-state-acl-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const state = path.join(base, 'private state');
  security.check('create', state);
  const token = path.join(state, 'token.txt');
  fs.writeFileSync(token, 'synthetic-test-token');
  security.assertEntry(token, false);
  security.assertTree(state);
  const linked = path.join(state, 'link.txt');
  fs.linkSync(token, linked);
  assert.throws(() => security.assertEntry(token, false), { code: 'HOST_STATE_UNSAFE' });
  assert.throws(() => security.assertTree(state), { code: 'HOST_STATE_UNSAFE' });
  fs.unlinkSync(linked);
  const junction = path.join(base, 'junction');
  fs.symlinkSync(state, junction, 'junction');
  assert.throws(() => security.check('create', path.join(junction, 'child')), { code: 'HOST_STATE_UNSAFE' });
  assert.equal(fs.existsSync(path.join(state, 'child')), false);
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();"
    + "$a=[IO.File]::GetAccessControl($p);$s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');"
    + "$r=New-Object Security.AccessControl.FileSystemAccessRule($s,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow);"
    + "$null=$a.AddAccessRule($r);[IO.File]::SetAccessControl($p,$a)";
  const changed = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { input: token, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(changed.status, 0, changed.stderr);
  assert.throws(() => security.assertEntry(token, false), { code: 'HOST_STATE_UNSAFE' });
  assert.throws(() => security.assertTree(state), { code: 'HOST_STATE_UNSAFE' });
  assert.equal(fs.readFileSync(token, 'utf8'), 'synthetic-test-token');
});
