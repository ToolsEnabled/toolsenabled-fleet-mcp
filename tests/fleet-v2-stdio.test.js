'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const cli = path.resolve(__dirname, '../bin/fleetV2.js');
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TOOLSENABLED_') && name !== 'OPENSHELL_SANDBOX'));

for (const workers of [false, true]) test(`standalone stdio ${workers ? 'worker' : 'coordination'} mode enforces and refreshes folder scope`, { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.homedir(), 'fleetV2-stdio-test-'));
  const workspace = path.join(root, 'project'); const other = path.join(root, 'other'); const state = path.join(root, 'state');
  fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(other, { mode: 0o700 });
  const file = path.join(other, 'proof.txt'); fs.writeFileSync(file, 'scope proof\n');
  const run = args => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30000 });
  const setup = run(['setup', '--workspace', workspace, '--state-root', state, '--read-root', workspace, '--read-root', other,
    '--write-root', other, ...(workers ? [] : ['--coordination-only'])]);
  assert.equal(setup.status, 0, setup.stderr);
  const child = spawn(process.execPath, [cli, 'serve', '--state-root', state, '--actor', 'codex'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  let sequence = 0; const pending = new Map();
  const input = readline.createInterface({ input: child.stdout });
  input.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id); if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`)); }
    pending.clear(); resolve({ code, signal });
  }));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    await exited; clearTimeout(timer); input.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out on ${method}: ${stderr}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fleetV2-qualification', version: '1' } });
  assert.equal(initialized.result?.serverInfo?.name, 'fleetV2', JSON.stringify(initialized));
  assert.equal(initialized.result.serverInfo.version, require('../fleetV2.json').version);
  const listed = await rpc('tools/list', {}); assert.ok(Array.isArray(listed.result?.tools), JSON.stringify(listed));
  const names = listed.result.tools.map(tool => tool.name);
  assert.equal(names.some(name => /agent_comms[._]send_local/.test(name)), false);
  const read = names.find(name => /^host[._]read_file$/.test(name)); assert.ok(read, names.join(','));
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const allowed = await call(read, { path: file });
  assert.equal(allowed.result?.isError, undefined, JSON.stringify(allowed));
  assert.match(JSON.stringify(allowed.result), /scope proof/);
  if (workers) {
    const control = names.find(name => /^fleet[._]control$/.test(name)); assert.ok(control);
    const result = await call(control, { action: 'read' });
    assert.equal(result.result?.isError, undefined, JSON.stringify(result));
  }
  const update = run(['scope', '--state-root', state, '--revision', '1', '--read-root', workspace]);
  assert.equal(update.status, 0, update.stderr);
  const refused = await call(read, { path: file });
  assert.equal(refused.result?.isError, true, JSON.stringify(refused));
  assert.match(JSON.stringify(refused), /FLEET_FOLDER_SCOPE_DENIED/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'scope proof\n');
});
