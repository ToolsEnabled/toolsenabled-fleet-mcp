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


test('native configuration publication waits for short readers and refuses persistent locks', native, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-publish-lock-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const destination = path.join(base, 'host-mode.json'), source = path.join(base, 'replacement.tmp');
  fs.writeFileSync(destination, 'old'); fs.writeFileSync(source, 'new');
  const probe = `using System; using System.IO; using System.Threading;
    public static class FleetPublishReaderProbe {
      public static void Run(string file, bool release, Action publish) {
        var reader = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        Thread closer = null;
        if (release) { closer = new Thread(() => { Thread.Sleep(350); reader.Dispose(); }); closer.Start(); }
        try { publish(); } finally { if (closer != null) closer.Join(); reader.Dispose(); }
      }
    }`;
  const command = "$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;"
    + 'Add-Type -Path $r.helper;Add-Type -TypeDefinition $r.probe;'
    + '$publish=[Action]{[ToolsEngineInstallerVolume]::PublishFile($r.source,$r.destination)};'
    + '$watch=[Diagnostics.Stopwatch]::StartNew();'
    + 'try{[FleetPublishReaderProbe]::Run($r.destination,$r.release,$publish);$ok=$true}catch{$ok=$false};'
    + '@{ok=$ok;elapsed=$watch.ElapsedMilliseconds}|ConvertTo-Json -Compress';
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = release => {
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')], {
      input: JSON.stringify({ helper: path.join(engine, 'tools/windows-volume.cs'), probe, source, destination, release }),
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  };
  const blocked = run(false);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.elapsed >= 1900 && blocked.elapsed < 5000, JSON.stringify(blocked));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
  assert.equal(fs.readFileSync(source, 'utf8'), 'new');
  const transient = run(true);
  assert.equal(transient.ok, true, JSON.stringify(transient));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
  assert.equal(fs.existsSync(source), false);
});
