'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

test('native Fleet setup, worker-enabled stdio and owner state roundtrip without WSL', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const base = fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleet-native-test-'));
  const state = path.join(base, 'state'), workspace = path.join(base, 'workspace');
  const entry = path.join(process.env.FLEET_PACKAGED_ENGINE || path.resolve(__dirname, '..'), 'bin/toolsenabled-host.js');
  const setup = spawnSync(process.execPath, [entry, 'setup', '--plugin',
    '--workspace', workspace, '--state-root', state, '--tier', 'standard', '--enable-workers'], {
    encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  // Preserve failures, including private state, for diagnosis.
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).workers, true);
  const child = spawn(process.execPath, [entry, 'serve', '--state-root', state, '--actor', 'codex'], {
    cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '', sequence = 0, completed = false;
  const pending = new Map();
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', error => { for (const request of pending.values()) request.reject(error); });
  child.on('close', code => { for (const request of pending.values()) request.reject(new Error(`Host exited ${code}: ${stderr}`)); pending.clear(); });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let packet; try { packet = JSON.parse(line); } catch { return; }
    if (!pending.has(packet.id)) return;
    const request = pending.get(packet.id); pending.delete(packet.id);
    packet.error ? request.reject(new Error(JSON.stringify(packet.error))) : request.resolve(packet.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 60000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await closed; clearTimeout(timer);
    if (completed) fs.rmSync(base, { recursive: true, force: true });
  });
  const initialized = await call('initialize', { protocolVersion: '2024-11-05',
    capabilities: {}, clientInfo: { name: 'native-windows-qualification', version: '1' } });
  assert.ok(initialized.serverInfo);
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await call('tools/list');
  assert.ok(listed.tools.some(tool => tool.name === 'agent.spawn'), 'full standalone workers must be offered');
  assert.ok(listed.tools.some(tool => tool.name === 'task.list'));
  const status = await call('tools/call', { name: 'system.status', arguments: {} });
  assert.notEqual(status.isError, true, JSON.stringify(status));
  const saved = JSON.parse(fs.readFileSync(path.join(state, 'host-mode.json'), 'utf8'));
  assert.equal(saved.nodePath, process.execPath);
  assert.equal(saved.workspace, workspace);
  assert.equal(saved.workers, true);
  completed = true;
});
