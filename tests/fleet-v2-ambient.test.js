'use strict';
require('./lib/isolated-environment').activate('fleet-v2-ambient');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const runtime = require('../src/lib/host-runtime');
const contexts = require('../src/lib/file-tool-context'), access = require('../src/lib/host-file-access');
const registry = require('../src/lib/tool-registry'), policy = require('../src/lib/permission-tier-policy');
test('explicit ambient setup preserves external sandbox flags and mediates outside setup workspace from starting cwd', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleetV2-ambient-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'setup'), cwd = path.join(root, 'terminal'), other = path.join(root, 'other');
  for (const folder of [workspace, cwd, other]) fs.mkdirSync(folder, { mode: 0o700 });
  fs.writeFileSync(path.join(cwd, 'relative.txt'), 'terminal bytes');
  fs.writeFileSync(path.join(other, 'shared.txt'), 'old bytes');
  const config = { schemaVersion: 1, mode: 'host', profile: 'fleetV2', fleetV2Security: 'inherited-environment', workers: false, tier: 'unrestricted',
    stateRoot: path.join(root, 'state'), workspace, installRoot: runtime.INSTALL_ROOT, nodePath: process.execPath };
  process.env.OPENSHELL_SANDBOX = '1';
  process.env.TOOLSENABLED_OPENSHELL_EXTERNAL_POLICY = 'preserved';
  runtime.setupHost(config);
  assert.equal(process.env.OPENSHELL_SANDBOX, '1');
  assert.equal(process.env.TOOLSENABLED_OPENSHELL_EXTERNAL_POLICY, 'preserved');
  fs.writeFileSync(path.join(config.stateRoot, 'host-mode.json'), JSON.stringify(config), { mode: 0o600 });
  assert.equal(runtime.readHostConfig(config.stateRoot).fleetV2Security, 'inherited-environment');
  fs.writeFileSync(path.join(config.stateRoot, 'host-mode.json'), JSON.stringify({ ...config, fleetV2Scope: { readRoots: [workspace], writeRoots: [], revision: 1, source: 'legacy' } }), { mode: 0o600 });
  assert.throws(() => runtime.readHostConfig(config.stateRoot), { code: 'HOST_CONFIG_INVALID' });
  fs.writeFileSync(path.join(config.stateRoot, 'host-mode.json'), JSON.stringify(config), { mode: 0o600 });
  const fileToolContext = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
  t.after(() => { contexts.retireFileToolContext(fileToolContext, 'finished'); delete process.env.OPENSHELL_SANDBOX; delete process.env.TOOLSENABLED_OPENSHELL_EXTERNAL_POLICY; });
  let admitted = true;
  const context = { fileToolContext, permissionSession: policy.effectiveSession(2), workspaceRoots: [cwd] };
  context.hostFileAuthorization = access.createAmbient({ fileToolContext, resolveAmbientAccess: async () => admitted, cwd });
  const call = (name, args) => registry.executeTool(name, args, context).then(result => result.result || result);
  assert.equal((await call('host.read_file', { path: 'relative.txt' })).content, 'terminal bytes');
  const external = path.join(other, 'shared.txt');
  assert.equal((await call('host.read_file', { path: external })).content, 'old bytes');
  await call('host.patch_file', { path: external, oldText: 'old', newText: 'new' });
  assert.equal(fs.readFileSync(external, 'utf8'), 'new bytes');
  assert.equal((await call('host.list_dir', {})).path, cwd);
  admitted = false;
  await assert.rejects(call('host.read_file', { path: external }), { code: 'FLEET_AMBIENT_ACCESS_REVOKED' });
  process.env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin';
  assert.equal(access.createAmbient({ fileToolContext, resolveAmbientAccess: async () => true, cwd }), undefined);
  delete process.env.TOOLSENABLED_HOST_SETUP_KIND;
});
test('ambient selection is explicit and never widens a saved declared scope or V1 environment', () => {
  assert.throws(() => runtime.requireHostEnvironment({ OPENSHELL_SANDBOX: '1' }), { code: 'HOST_MODE_CONFLICT' });
  assert.doesNotThrow(() => runtime.requireHostEnvironment({ OPENSHELL_SANDBOX: '1' }, { inheritedEnvironment: true }));
  const { workerFolder } = require('../src/lib/host-agent-mode');
  const cwd = fs.realpathSync(os.tmpdir());
  assert.equal(workerFolder({ profile: 'fleetV2', fleetV2Security: 'inherited-environment', workspace: '/unused' }, cwd), cwd);
  assert.equal(workerFolder({ profile: 'fleetV2', workspace: '/legacy-scoped' }, cwd), '/legacy-scoped');
});
test('ambient actual host startup preserves sandbox environment and durable lifecycle without any folder-scope watcher', async t => {
  const { startHostAgentMode } = require('../src/lib/host-agent-mode');
  const { createOpenShellAgentHost, openShellRoleHooks } = require('../src/lib/openshell-agent-host');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fv2a-'))), sessions = [];
  const config = { mode: 'host', workers: true, profile: 'fleetV2', fleetV2Security: 'inherited-environment', tier: 'unrestricted', stateRoot: root, workspace: root };
  let backend, capturedEnv, turn = 0;
  const mode = startHostAgentMode({ config, listen: false, env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1',
    TOOLSENABLED_FLEET_PROFILE: 'fleetV2', OPENSHELL_SANDBOX: '1', TOOLSENABLED_OPENSHELL_AGENTS: '1',
    TOOLSENABLED_TOOL_ALLOWLIST: require('../src/lib/host-surface').hostAllowlist({ workers: true, fleetV2: true }).join(',') },
    createLauncher: ({ env, workspaceRoot }) => { capturedEnv = env; assert.equal(workspaceRoot, fs.realpathSync(process.cwd())); return { async start(spec) {
      const session = { spec, threadId: 'ambient-thread', close() {}, async quiesce() { this.closed = true; },
        adapter: { async sendTurn() { return { threadId: session.threadId, turnId: `turn-${++turn}` }; }, async interrupt() {} } };
      sessions.push(session); return session;
    } }; },
    createHost: options => { assert.equal(options.folderScope, undefined); backend = createOpenShellAgentHost({ ...options,
      roleHooks: openShellRoleHooks({ roles: null }), leadLevel: 4, watchIntervalMs: 0, codexEndpoint: () => null }); return backend; } });
  t.after(async () => { await mode.close(); require('../src/lib/tree-host-registry').clearTreeSpawnHost(); fs.rmSync(root, { recursive: true, force: true }); });
  await mode.ready;
  assert.equal(capturedEnv.OPENSHELL_SANDBOX, '1'); assert.equal(capturedEnv.TOOLSENABLED_OPENSHELL_AGENTS, '1');
  assert.equal(mode.context.resolveFolderScope, undefined); assert.equal(typeof mode.context.resolveAmbientAccess, 'function');
  const previousAllowlist = process.env.TOOLSENABLED_TOOL_ALLOWLIST;
  process.env.TOOLSENABLED_TOOL_ALLOWLIST = require('../src/lib/host-surface').hostAllowlist({ workers: true, fleetV2: true }).join(',');
  t.after(() => { process.env.TOOLSENABLED_TOOL_ALLOWLIST = previousAllowlist; });
  const worker = await registry.executeTool('agent.spawn', { tier: 'luna', provider: 'codex', contract: ['CONTRACT/1', 'role WORKER', 'target .', 'do Ambient durable task', 'because The user requested 1 ambient worker fixture.', 'done The final reply says it is done', 'report reply'].join('\n') },
    { ...mode.context, permissionSession: policy.effectiveSession(2) });
  assert.equal(sessions[0].spec.fleetV2Security, 'inherited-environment');
  const identity = await backend.handleLink(sessions[0].spec.linkToken, 'file.access');
  assert.equal(identity.fleetV2Security, 'inherited-environment'); assert.equal(identity.folderScope, undefined);
  const read = await mode.host.fleetControl({ action: 'read' }, mode.context.agentSessionId);
  assert.match(read.tasks[worker.nodeId].text, /Ambient durable task/);
  await mode.host.fleetControl({ action: 'pause', nodeId: worker.nodeId, expectedRevision: read.revision }, mode.context.agentSessionId);
  assert.equal(sessions[0].closed, true);
});
