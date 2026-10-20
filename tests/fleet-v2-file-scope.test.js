'use strict';
require('./lib/isolated-environment').activate('fleet-v2-file-scope');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../src/lib/host-runtime');
const registry = require('../src/lib/tool-registry');
const contexts = require('../src/lib/file-tool-context');
const access = require('../src/lib/host-file-access');
const policy = require('../src/lib/permission-tier-policy');

test('fleetV2 mediation follows exact live parent read/write roots independently of approval mode', async t => {
  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleetV2-file-test-'));
  const workspace = path.join(root, 'project'); const other = path.join(root, 'other'); const outside = path.join(root, 'outside');
  for (const folder of [workspace, other, outside]) fs.mkdirSync(folder, { mode: 0o700 });
  const file = path.join(other, 'shared.txt'); const denied = path.join(outside, 'outside.txt');
  fs.writeFileSync(file, 'original\n'); fs.writeFileSync(denied, 'not authorized\n');
  let live = { readRoots: [workspace, other], writeRoots: [other], revision: 1, source: 'parent-fixture' };
  const config = { schemaVersion: 1, mode: 'host', profile: 'fleetV2', workers: false, tier: 'unrestricted',
    stateRoot: path.join(root, 'state'), workspace, installRoot: runtime.INSTALL_ROOT, nodePath: process.execPath, fleetV2Scope: live };
  delete process.env.OPENSHELL_SANDBOX; runtime.setupHost(config);
  fs.writeFileSync(path.join(config.stateRoot, 'host-mode.json'), JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fileToolContext = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
  t.after(() => contexts.retireFileToolContext(fileToolContext, 'test-finished'));
  const context = { fileToolContext, permissionSession: policy.effectiveSession(2), workspaceRoots: [workspace] };
  context.hostFileAuthorization = access.createScoped({ fileToolContext, resolveFolderScope: async () => live });
  assert.ok(context.hostFileAuthorization);
  const call = (name, args) => registry.executeTool(name, args, context).then(result => result.result || result);

  await t.test('a second authorized folder participates in real byte mediation', async () => {
    assert.equal((await call('host.read_file', { path: file })).content, 'original\n');
    await call('host.patch_file', { path: file, oldText: 'original', newText: 'changed' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed\n');
    assert.equal((await call('host.list_dir', { path: other })).path, other);
  });
  await t.test('read-only roots and unauthorized siblings remain denied', async () => {
    await assert.rejects(call('host.write_file', { path: path.join(workspace, 'no.txt'), content: 'no' }), { code: 'FLEET_FOLDER_SCOPE_DENIED' });
    for (const [name, args] of [['host.read_file', { path: denied }], ['host.list_dir', { path: outside }],
      ['host.write_file', { path: denied, content: 'no' }]]) await assert.rejects(call(name, args), { code: 'FLEET_FOLDER_SCOPE_DENIED' });
    assert.equal(fs.readFileSync(denied, 'utf8'), 'not authorized\n');
  });
  await t.test('canonical aliases cannot reach a sibling outside the folder policy', { skip: process.platform === 'win32' }, async () => {
    const alias = path.join(other, 'alias'); fs.symlinkSync(outside, alias);
    await assert.rejects(call('host.read_file', { path: path.join(alias, 'outside.txt') }), { code: 'FLEET_FOLDER_SCOPE_DENIED' });
  });
  await t.test('disabling byte mediation cannot disable the independent folder boundary', async () => {
    process.env.TOOLSENABLED_HOST_BYTE_MEDIATION = 'off';
    try {
      await assert.rejects(call('host.write_file', { path: path.join(workspace, 'not-writable.txt'), content: 'denied' }), { code: 'FLEET_FOLDER_SCOPE_DENIED' });
      assert.equal((await call('host.read_file', { path: file })).content, 'changed\n');
      await assert.rejects(call('host.read_file', { path: denied }), { code: 'FLEET_FOLDER_SCOPE_DENIED' });
      assert.equal(fs.existsSync(path.join(workspace, 'not-writable.txt')), false);
    } finally { delete process.env.TOOLSENABLED_HOST_BYTE_MEDIATION; }
  });
  await t.test('a policy change during admission refuses before directory enumeration', async () => {
    let admit;
    const prepared = await access.prepare(context);
    const provider = require('../src/lib/providers/host-control');
    const pending = access.run(prepared, () => provider.listDir({ path: other }, {
      requireRecordAsync: () => new Promise(resolve => { admit = resolve; }), recordAsync: async () => {} }));
    live = { ...live, readRoots: [workspace], writeRoots: [], revision: 2 };
    const readdir = fs.readdirSync; let enumerated = false;
    fs.readdirSync = (value, ...args) => { if (value === other) enumerated = true; return readdir(value, ...args); };
    try { admit(); await assert.rejects(pending, { code: 'FLEET_FOLDER_SCOPE_CHANGED' }); assert.equal(enumerated, false); }
    finally { fs.readdirSync = readdir; }
    await assert.rejects(call('host.read_file', { path: file }), { code: 'FLEET_FOLDER_SCOPE_DENIED' });
    live = { ...live, readRoots: [workspace, other], writeRoots: [other], revision: 3 };
    assert.equal((await call('host.read_file', { path: file })).content, 'changed\n');
  });
  await t.test('a forged authority object and vendor plugin cannot select fleetV2 roots', async () => {
    const forged = { ...context, hostFileAuthorization: { resolveFolderScope: async () => live } };
    await assert.rejects(registry.executeTool('host.read_file', { path: file }, forged), { code: 'PERMISSION_CONFINED_WORKSPACE_REFUSED' });
    process.env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin';
    try { assert.equal(access.createScoped({ fileToolContext, resolveFolderScope: async () => live }), undefined); }
    finally { delete process.env.TOOLSENABLED_HOST_SETUP_KIND; }
  });
});
