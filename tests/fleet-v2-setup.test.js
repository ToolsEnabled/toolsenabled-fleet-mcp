'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/fleetV2.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.homedir(), 'fleetV2-setup-test-'));
  fs.chmodSync(root, 0o700);
  for (const name of ['project', 'other']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { root, workspace: path.join(root, 'project'), stateRoot: path.join(root, 'state'), other: path.join(root, 'other') };
}
function run(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TOOLSENABLED_') && name !== 'OPENSHELL_SANDBOX'));
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, cwd, timeout: 120_000 });
}
function args(f) { return ['setup', '--workspace', f.workspace, '--state-root', f.stateRoot, '--coordination-only']; }

test('fleetV2 defaults to the terminal directory and inherited environment without a folder sandbox', t => {
  const f = fixture(t);
  const result = run(['setup', '--state-root', f.stateRoot, '--coordination-only'], f.workspace);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  const config = JSON.parse(fs.readFileSync(path.join(f.stateRoot, 'host-mode.json')));
  assert.equal(config.workspace, fs.realpathSync(f.workspace));
  assert.equal(config.fleetV2Security, 'inherited-environment');
  assert.equal(config.fleetV2Scope, undefined);
  assert.equal(answer.security, 'inherited-environment');
  const update = run(['scope', '--state-root', f.stateRoot, '--revision', '1', '--read-root', f.workspace]);
  assert.equal(update.status, 1); assert.match(update.stderr, /FLEET_V2_EXTERNAL_SANDBOX/);
});
test('fleetV2 setup persists a separate standalone profile and exact multi-folder roots', t => {
  const f = fixture(t);
  const result = run([...args(f), '--read-root', f.workspace, '--read-root', f.other, '--write-root', f.other]);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout); const config = JSON.parse(fs.readFileSync(path.join(f.stateRoot, 'host-mode.json')));
  assert.equal(answer.name, 'fleetV2'); assert.equal(config.profile, 'fleetV2'); assert.equal(config.setupKind, undefined);
  assert.deepEqual(config.fleetV2Scope.readRoots, [f.other, f.workspace].sort());
  assert.deepEqual(config.fleetV2Scope.writeRoots, [f.other]); assert.equal(config.fleetV2Scope.revision, 1);
  assert.equal(config.workers, false); assert.ok(answer.server.args.includes(cli));
  const status = run(['status', '--state-root', f.stateRoot]); assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).folderScope, config.fleetV2Scope);
  assert.equal(run(['serve', '--state-root', f.stateRoot, '--actor', 'codex', '--write-root', f.root]).status, 1);
});
test('fleetV2 readonly root stays readonly and cannot be overwritten by setup', t => {
  const f = fixture(t); const result = run([...args(f), '--read-root', f.workspace]); assert.equal(result.status, 0, result.stderr);
  const file = path.join(f.stateRoot, 'host-mode.json'); const before = fs.readFileSync(file);
  assert.deepEqual(JSON.parse(before).fleetV2Scope.writeRoots, []);
  const second = run([...args(f), '--read-root', f.root, '--write-root', f.root]);
  assert.equal(second.status, 1); assert.match(second.stderr, /FLEET_V2_STATE_EXISTS/); assert.deepEqual(fs.readFileSync(file), before);
});
test('fleetV2 rejects writes outside read scope and workspace outside scope before setup', t => {
  const f = fixture(t);
  const write = run([...args(f), '--read-root', f.workspace, '--write-root', f.other]);
  assert.equal(write.status, 1); assert.match(write.stderr, /FLEET_V2_SCOPE_INVALID/);
  const read = run([...args(f), '--read-root', f.other]); assert.equal(read.status, 1); assert.match(read.stderr, /FLEET_V2_WORKSPACE_OUTSIDE_SCOPE/);
  assert.equal(fs.existsSync(f.stateRoot), false);
});
test('fleetV2 refuses aliased data roots', { skip: process.platform === 'win32' ? 'Symlink privilege differs; native junction qualification is separate.' : false }, t => {
  const f = fixture(t); const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.workspace, alias);
  const result = run([...args(f), '--read-root', alias]); assert.equal(result.status, 1); assert.match(result.stderr, /FLEET_FOLDER_SCOPE_INVALID/);
  assert.equal(fs.existsSync(f.stateRoot), false);
});

test('a user scope edit advances one revision and refuses stale updates without changing the saved policy', t => {
  const f = fixture(t); const result = run([...args(f), '--read-root', f.workspace]); assert.equal(result.status, 0, result.stderr);
  const update = run(['scope', '--state-root', f.stateRoot, '--revision', '1', '--read-root', f.workspace, '--read-root', f.other, '--write-root', f.other]);
  assert.equal(update.status, 0, update.stderr); assert.equal(JSON.parse(update.stdout).status, 'recorded');
  const before = fs.readFileSync(path.join(f.stateRoot, 'host-mode.json'));
  const config = JSON.parse(before); assert.equal(config.fleetV2Scope.revision, 2); assert.deepEqual(config.fleetV2Scope.writeRoots, [f.other]);
  const stale = run(['scope', '--state-root', f.stateRoot, '--revision', '1', '--read-root', f.workspace]);
  assert.equal(stale.status, 1, stale.stderr); assert.match(stale.stderr, /FLEET_V2_REVISION_CONFLICT/);
  assert.deepEqual(fs.readFileSync(path.join(f.stateRoot, 'host-mode.json')), before);
});

test('explicit all-files read authority never grants all-files write authority', t => {
  const f = fixture(t); const result = run([...args(f), '--read-all', '--write-root', f.workspace]);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(f.stateRoot, 'host-mode.json')));
  assert.equal(config.fleetV2Scope.readAll, true); assert.deepEqual(config.fleetV2Scope.writeRoots, [f.workspace]);
  const update = run(['scope', '--state-root', f.stateRoot, '--revision', '1', '--read-root', f.workspace]);
  assert.equal(update.status, 0, update.stderr); const next = JSON.parse(update.stdout).folderScope;
  assert.notEqual(next.readAll, true); assert.deepEqual(next.writeRoots, []);
});
