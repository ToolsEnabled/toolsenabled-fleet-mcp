'use strict';
// Native portable host installer. Provider CLIs and their configuration remain
// under the owner's control; stdout returns the exact stdio MCP registration.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const here = __dirname;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const security = require('./runtime/src/lib/windows-state-security');
const inside = (root, value) => {
  const relative = path.relative(root.toLowerCase(), value.toLowerCase());
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function manifest(folder) {
  const record = JSON.parse(fs.readFileSync(path.join(folder, 'release.json'), 'utf8'));
  assert.equal(record.name, 'toolsenabled-fleet');
  assert.equal(record.target, 'windows-x64');
  assert.match(record.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/);
  assert.match(record.commit, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(record.files) && record.files.length > 0);
  const names = new Set();
  for (const file of record.files) {
    assert.ok(typeof file.path === 'string' && !/[\\:\0]/.test(file.path)
      && file.path.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)));
    assert.ok(!names.has(file.path.toLowerCase()), 'Duplicate release member.');
    names.add(file.path.toLowerCase());
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  return record;
}
function verify(folder, record, installed = false) {
  const expected = new Set([...record.files.map(file => file.path), 'release.json', ...(installed ? ['installation.json'] : [])]);
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      assert.ok(!stat.isSymbolicLink(), `Linked release member: ${name}`);
      if (stat.isDirectory()) walk(full, name + '/');
      else {
        assert.ok(stat.isFile() && stat.nlink === 1 && expected.delete(name), `Unexpected release member: ${name}`);
      }
    }
  }
  walk(folder);
  assert.equal(expected.size, 0, 'Release members are missing.');
  for (const file of record.files) {
    const bytes = fs.readFileSync(path.join(folder, file.path));
    assert.equal(bytes.length, file.size, file.path);
    assert.equal(sha(bytes), file.sha256, file.path);
  }
}
function run(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'Fleet command failed.');
  return result.stdout.trim();
}
async function requireIdle(stateRoot) {
  security.assertTree(stateRoot);
  const folder = path.join(stateRoot, 'interactions');
  if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder)) {
    assert.match(name, /^[a-f0-9-]{36}\.json$/);
    const descriptor = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
    assert.match(descriptor.socketPath, /^\\\\\.\\pipe\\te-tree-[a-f0-9]{32}$/);
    const dead = await new Promise(resolve => {
      const socket = require('node:net').connect(descriptor.socketPath);
      const done = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
      socket.once('connect', () => done(false));
      socket.once('error', error => done(['ENOENT', 'ECONNREFUSED'].includes(error.code)));
      socket.setTimeout(1000, () => done(false));
    });
    assert.ok(dead, 'Close every Fleet client before uninstalling; an active or unobservable server was retained.');
  }
}
async function main(argv) {
  assert.equal(process.platform, 'win32', 'This package requires native Windows.');
  assert.equal(process.arch, 'x64');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 19, 'Install Node.js 22.19 or newer.');
  const record = manifest(here);
  const home = fs.realpathSync(os.userInfo().homedir);
  const options = { root: path.join(home, '.toolsenabled-fleet'), workers: false, tier: 'unrestricted' };
  const action = ['check', 'uninstall'].includes(argv[0]) ? argv.shift() : 'install';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--enable-workers') options.workers = true;
    else if (['--root', '--workspace', '--tier'].includes(flag) && argv[i + 1]) options[flag.slice(2)] = argv[++i];
    else throw Error(`Unknown or incomplete option: ${flag}`);
  }
  if (action !== 'install') {
    assert.equal(argv.length, 0, 'Run check or uninstall from the installed copy without additional options.');
    security.assertTree(here);
    const saved = JSON.parse(fs.readFileSync(path.join(here, 'installation.json'), 'utf8'));
    assert.equal(saved.directory, here);
    assert.equal(saved.version, record.version);
    assert.equal(saved.releaseSha256, sha(fs.readFileSync(path.join(here, 'release.json'))));
    verify(here, record, true);
    if (action === 'check') {
      run(path.join(here, 'runtime/bin/toolsenabled-host.js'), ['status', '--state-root', saved.stateRoot, '--json', '--no-agents']);
      console.log(JSON.stringify({ checked: true, version: record.version, mcpServer: saved.mcpServer }));
      return;
    }
    // The owner closes clients before uninstalling. No broad process stop,
    // recursive state removal or provider configuration edits.
    assert.ok(inside(home, here), 'An installed copy must remain inside the account profile.');
    await requireIdle(saved.stateRoot);
    for (const name of [...record.files.map(file => file.path), 'release.json', 'installation.json']) fs.unlinkSync(path.join(here, name));
    const removeEmpty = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        assert.ok(entry.isDirectory(), 'A new file appeared during uninstall; retain it.');
        removeEmpty(path.join(directory, entry.name));
      }
      fs.rmdirSync(directory);
    };
    removeEmpty(here);
    console.log(JSON.stringify({ removed: here, retainedState: saved.stateRoot,
      registration: 'Remove the toolsenabled-fleet entry from your MCP client if you added it.' }));
    return;
  }
  verify(here, record);
  assert.ok(options.workspace && path.isAbsolute(options.workspace), '--workspace needs an absolute project folder.');
  options.root = path.resolve(options.root);
  const workspace = path.resolve(options.workspace);
  assert.ok(inside(home, options.root), 'Install inside the operating-system account profile.');
  assert.ok(!inside(options.root, here) && !inside(here, options.root) && options.root.toLowerCase() !== here.toLowerCase(), 'Extract the release outside its installation root.');
  assert.ok(!inside(options.root, workspace) && !inside(workspace, options.root) && options.root.toLowerCase() !== workspace.toLowerCase(), 'Workspace and installation must be separate.');
  security.check('ancestors', options.root);
  const stateRoot = path.join(options.root, 'state');
  assert.equal(fs.existsSync(stateRoot), false, 'Existing Fleet state is retained. Select a fresh --root for this installation.');
  const destination = path.join(options.root, 'versions', record.version);
  assert.equal(fs.existsSync(destination), false, 'This version is already installed; run its check command.');
  security.check('create', destination);
  const directories = new Set([destination]);
  for (const file of [...record.files, { path: 'release.json' }]) {
    const target = path.join(destination, file.path);
    const parent = path.dirname(target);
    if (!directories.has(parent)) { security.check('create', parent); directories.add(parent); }
    fs.copyFileSync(path.join(here, file.path), target, fs.constants.COPYFILE_EXCL);
  }
  security.assertTree(destination);
  verify(destination, record);
  const entry = path.join(destination, 'runtime/bin/toolsenabled-host.js');
  security.check('create', stateRoot);
  fs.writeFileSync(path.join(stateRoot, 'host-mode.json'), JSON.stringify({
    schemaVersion: 1, mode: 'host', workers: options.workers, tier: options.tier,
    workspace, stateRoot, installRoot: path.join(destination, 'runtime'), nodePath: process.execPath
  }, null, 2) + '\n', { flag: 'wx' });
  security.assertTree(stateRoot);
  run(entry, ['setup', '--state-root', stateRoot]);
  const mcpServer = JSON.parse(run(entry, ['setup', '--state-root', stateRoot, '--print-server-json']));
  const saved = { version: record.version, directory: destination, stateRoot, workspace,
    releaseSha256: sha(fs.readFileSync(path.join(destination, 'release.json'))), mcpServer };
  fs.writeFileSync(path.join(destination, 'installation.json'), JSON.stringify(saved, null, 2) + '\n', { flag: 'wx' });
  security.assertTree(destination);
  console.log(JSON.stringify({ installed: destination, mcpServers: { 'toolsenabled-fleet': mcpServer },
    check: [process.execPath, path.join(destination, 'install.cjs'), 'check'],
    uninstall: [process.execPath, path.join(destination, 'install.cjs'), 'uninstall'] }, null, 2));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
