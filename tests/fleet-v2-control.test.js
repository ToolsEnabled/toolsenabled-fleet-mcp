'use strict';
require('./lib/isolated-environment').activate('fleet-v2-control');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFleetControl } = require('../src/lib/fleet-v2-control');
function fixture(extra = {}) {
  const document = { nodes: [{ nodeId: 'builder', sessionId: 'worker-1', state: 'running' }] };
  const saved = [], commands = [];
  const control = createFleetControl({ document, rootSessionId: 'root', persist: doc => saved.push(JSON.parse(JSON.stringify(doc))),
    command: async request => { commands.push(request); document.nodes[0].state = request.action === 'resume-node' ? 'running' : 'paused'; return { ok: true }; }, ...extra });
  control.ensureTask('builder', 'Original');
  return { document, control, saved, commands };
}
test('durable pause/edit/rule/resume uses current revision; stale and active edits refuse', async () => {
  const { control, saved, commands } = fixture();
  await assert.rejects(control.request({ action: 'task', nodeId: 'builder', text: 'Bad', expectedRevision: 1 }, 'root'), { code: 'FLEET_TASK_PAUSE_REQUIRED' });
  await control.request({ action: 'pause', nodeId: 'builder', expectedRevision: 1 }, 'root');
  await control.request({ action: 'task', nodeId: 'builder', text: 'Current', expectedRevision: 2 }, 'root');
  await assert.rejects(control.request({ action: 'rule', id: 'rule', text: 'Stale', expectedRevision: 1 }, 'root'), { code: 'FLEET_CONTROL_STALE_REVISION' });
  await control.request({ action: 'rule', id: 'rule', text: 'Respect scope', expectedRevision: 3 }, 'root');
  await control.request({ action: 'resume', nodeId: 'builder', expectedRevision: 4 }, 'root');
  assert.match(control.assignment('builder').text, /Current/);
  assert.match(control.assignment('builder').text, /Respect scope/);
  assert.equal(control.assignment('builder').revision, 5);
  assert.equal(saved.at(-1).fleetControl.revision, 5);
  assert.deepEqual(commands.map(command => command.action), ['pause-node', 'resume-node']);
});
test('worker asks survive reconstruction, are discoverable and answer replay never reexecutes', async () => {
  const { control, document, commands } = fixture();
  await control.request({ action: 'ask', id: 'question', question: 'Which target?' }, 'worker-1');
  const retry = await control.request({ action: 'ask', id: 'question', question: 'Which target?' }, 'worker-1');
  assert.equal(retry.replay, true);
  assert.equal((await control.request({ action: 'read' }, 'root')).pendingAsks.length, 1);
  const restored = createFleetControl({ document: JSON.parse(JSON.stringify(document)), rootSessionId: 'root', persist() {}, command: async () => ({}) });
  assert.equal((await restored.request({ action: 'read' }, 'root')).pendingAsks[0].id, 'question');
  await assert.rejects(control.request({ action: 'answer', id: 'question', answer: 'A', expectedRevision: 2 }, 'worker-1'), { code: 'FLEET_CONTROL_ROOT_REQUIRED' });
  await control.request({ action: 'answer', id: 'question', answer: 'A', expectedRevision: 2 }, 'root');
  assert.equal(commands.length, 1);
  assert.equal((await control.request({ action: 'answer', id: 'question', answer: 'A', expectedRevision: 3 }, 'root')).replay, true);
  assert.equal(commands.length, 1);
  assert.match(control.assignment('builder').text, /Answer: A/);
  await control.request({ action: 'archive-ask', id: 'question', expectedRevision: 3 }, 'root');
  assert.equal(control.assignment('builder').text.includes('Answer: A'), false);
  assert.equal((await control.request({ action: 'answer', id: 'question', answer: 'A', expectedRevision: 4 }, 'root')).replay, true);
  await assert.rejects(control.request({ action: 'answer', id: 'question', answer: 'Changed', expectedRevision: 4 }, 'root'), { code: 'FLEET_ASK_ALREADY_ANSWERED' });
  await assert.rejects(control.request({ action: 'ask', id: 'question', question: 'Other?' }, 'worker-1'), { code: 'FLEET_CONTROL_WORKER_REQUIRED' });
});
test('concurrent revision edits have one winner; failed persistence restores old state', async () => {
  const { control, document } = fixture(); document.nodes[0].state = 'paused';
  const edits = await Promise.allSettled(['First', 'Second'].map(text => control.request({ action: 'task', nodeId: 'builder', text, expectedRevision: 1 }, 'root')));
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1);
  const broken = createFleetControl({ document, rootSessionId: 'root', persist() { throw new Error('disk'); }, command() {} });
  await assert.rejects(broken.request({ action: 'task', nodeId: 'builder', text: 'Lost', expectedRevision: 2 }, 'root'), /disk/);
  assert.match(broken.assignment('builder').text, /First/);
});
test('settings import inventories exact pinned rows and refuses folder/provider authority changes', () => {
  const settings = require('../src/lib/fleet-v2-settings');
  assert.equal(settings.inventory.entries.length, 103);
  assert.throws(() => settings.prepare({ 'capability.workspace_roots': ['/'] }), { code: 'FLEET_SETTING_EXCLUDED' });
  assert.deepEqual(settings.prepare({ 'agent.tool_approvals': false }).stored, [['agent.tool_approvals', false]]);
  assert.throws(() => settings.prepare({ 'fleet.tree_width': -1 }), { code: 'FLEET_SETTINGS_INVALID' });
  assert.equal(settings.prepare({ 'fleet.review_cadence': settings.inventory.entries.find(row => row.id === 'fleet.review_cadence').original.default }).policies['fleet.review_cadence'], settings.inventory.entries.find(row => row.id === 'fleet.review_cadence').original.default);
});
test('discovery and hidden dispatch enforce root messaging and standalone control surfaces', async () => {
  const registry = require('../src/lib/tool-registry');
  const hosts = require('../src/lib/tree-host-registry');
  const { hostAllowlist } = require('../src/lib/host-surface');
  const stub = { spawn() {}, isTreeSession() {}, fleetControlVersion: 1, fleetControl() {}, fleetOrchestrator: true };
  assert.equal(hostAllowlist({ workers: true }).includes('fleet.control'), false);
  assert.equal(hostAllowlist({ workers: true, fleetV2: true }).includes('fleet.control'), true);
  hosts.installTreeSpawnHost(stub);
  try {
    assert.equal(registry.registeredTools().some(tool => tool.name === 'fleet.control'), true);
    assert.equal(registry.registeredTools().some(tool => tool.name === 'agent_comms.send_local'), false);
    assert.throws(() => registry.assertToolRegistered('agent_comms.send_local'), { code: 'TOOL_NOT_ENABLED' });
    assert.equal(registry.registeredTools({ agentRole: { functions: ['settings.read'] } }).some(tool => tool.name === 'fleet.control'), false);
    stub.fleetOrchestrator = false;
    assert.deepEqual(registry.getTool('fleet.control').inputSchema.properties.action.enum, ['read', 'ask', 'progress', 'complete']);
    assert.equal(registry.getTool('fleet.control').inputSchema.properties.expectedRevision, undefined);
    assert.equal(registry.registeredTools().some(tool => tool.name === 'agent_comms.send_local'), true);
    stub.fleetControlVersion = 0;
    assert.throws(() => registry.assertToolRegistered('fleet.control'), { code: 'TOOL_NOT_ENABLED' });
  } finally { hosts.clearTreeSpawnHost(); }
});
test('message timers start at first arrival; end-of-turn withholds active steering', () => {
  const { decision, readPolicy } = require('../src/lib/fleet-v2-message-policy');
  const queue = [{ at: new Date(1000).toISOString() }, { at: new Date(1500).toISOString() }];
  assert.deepEqual(decision({ mode: 'timer', intervalMs: 1000 }, queue, { active: true, now: 1700 }), { allowed: false, delayMs: 300 });
  queue.push({ at: new Date(1900).toISOString() });
  assert.equal(decision({ mode: 'timer', intervalMs: 1000 }, queue, { active: true, now: 2000 }).allowed, true);
  assert.equal(decision({ mode: 'end-of-turn' }, queue, { active: true }).allowed, false);
  assert.equal(decision({ mode: 'end-of-turn' }, queue, { active: false }).allowed, true);
  assert.equal(decision({ mode: 'instant' }, queue, { active: true }).allowed, true);
  assert.throws(() => readPolicy({ read: () => ({ values: {}, rejected: [] }) }), { code: 'FLEET_MESSAGE_POLICY_INVALID' });
});
test('scope refresh serializes transition and refuses rollback or revisionless policy replacement', async () => {
  const { createScopeRefresh } = require('../src/lib/fleet-v2-scope-refresh');
  const scope = { readRoots: [process.cwd()], writeRoots: [process.cwd()], revision: 1, source: 'test-parent' };
  let next = { ...scope, revision: 2 }, active = 0, maximum = 0, calls = 0;
  const refresh = createScopeRefresh({ initialScope: scope, read: () => next, intervalMs: 0,
    update: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; calls++; } });
  await Promise.all([refresh.refresh(), refresh.refresh()]);
  assert.equal(calls, 1); assert.equal(maximum, 1);
  next = { ...scope, revision: 1 };
  await assert.rejects(refresh.refresh(), { code: 'FLEET_PARENT_SCOPE_UNAVAILABLE' });
  next = { ...scope, revision: 2, writeRoots: [] };
  await assert.rejects(refresh.refresh(), { code: 'FLEET_PARENT_SCOPE_UNAVAILABLE' });
  await refresh.close();
});
test('actual host startup routes durable asks, pause/edit/resume and scope refresh with stale token fencing', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { startHostAgentMode } = require('../src/lib/host-agent-mode');
  const { createOpenShellAgentHost, openShellRoleHooks } = require('../src/lib/openshell-agent-host');
  const { hostAllowlist } = require('../src/lib/host-surface');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fv2-control-')));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fv2r-')));
  const config = { mode: 'host', workers: true, profile: 'fleetV2', tier: 'unrestricted', stateRoot: scratch, workspace: scratch,
    fleetV2Scope: { readRoots: [scratch], writeRoots: [scratch], revision: 1, source: 'test-parent' } };
  fs.writeFileSync(path.join(scratch, 'host-mode.json'), JSON.stringify(config), { mode: 0o600 });
  const sessions = []; let backend, turnCount = 0;
  const launcher = { async start(spec) {
    const turns = [], session = { spec, turns, threadId: spec.threadId || `fresh-${sessions.length}`, close() { this.closed = true; }, async quiesce() { this.closed = true; },
      adapter: { sendTurn: async turn => { turns.push(turn); return { threadId: session.threadId, turnId: `turn-${++turnCount}` }; }, interrupt: async () => {} } };
    sessions.push(session); return session;
  } };
  const mode = startHostAgentMode({ config, listen: false, env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_FLEET_PROFILE: 'fleetV2',
    TOOLSENABLED_TOOL_ALLOWLIST: hostAllowlist({ workers: true, fleetV2: true }).join(','), XDG_RUNTIME_DIR: runtime },
    createLauncher: () => launcher, createHost: options => { backend = createOpenShellAgentHost({ ...options, roleHooks: openShellRoleHooks({ roles: null }), leadLevel: 4, watchIntervalMs: 0,
      getMessagePolicy: () => ({ mode: 'instant', intervalMs: 1000, resetAfterTask: true }) }); return backend; } });
  try {
    await mode.ready;
    const throughRegistry = await require('../src/lib/tool-registry').executeTool('fleet.control', { action: 'read' }, { ...mode.context, permissionSession: require('../src/lib/permission-tier-policy').installTierSession('unrestricted') });
    assert.equal(throughRegistry.revision, 0);
    const worker = await mode.host.spawn({ parentSessionId: mode.context.agentSessionId, tier: 'luna', role: 'worker', brief: 'Initial task' });
    const token = sessions[0].spec.linkToken;
    assert.equal(sessions[0].spec.serverEnv.TOOLSENABLED_TOOL_ALLOWLIST.includes('fleet.control'), true);
    const waiting = mode.host.wait({ parentSessionId: mode.context.agentSessionId, timeoutSeconds: 1 });
    await backend.handleLink(token, 'fleet-control', { action: 'ask', id: 'target', question: 'Which target?' });
    const notice = await waiting;
    assert.equal(notice.timedOut, false);
    assert.equal(notice.reports.some(report => report.kind === 'ask' && report.text.includes('target')), true);
    const pending = await mode.host.fleetControl({ action: 'read' }, mode.context.agentSessionId);
    assert.equal(pending.pendingAsks[0].question, 'Which target?');
    await mode.host.fleetControl({ action: 'answer', id: 'target', answer: 'Use current', expectedRevision: 2 }, mode.context.agentSessionId);
    assert.equal(sessions[0].closed, true);
    await assert.rejects(backend.handleLink(token, 'fleet-control', { action: 'read' }), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
    await mode.host.fleetControl({ action: 'task', nodeId: worker.nodeId, text: 'Replacement task', expectedRevision: 3 }, mode.context.agentSessionId);
    await mode.host.fleetControl({ action: 'resume', nodeId: worker.nodeId, expectedRevision: 4 }, mode.context.agentSessionId);
    assert.equal(sessions[1].spec.threadId, sessions[0].threadId);
    assert.match(sessions[1].turns[0].text, /Replacement task/);
    assert.match(sessions[1].turns[0].text, /Answer: Use current/);
    const secondToken = sessions[1].spec.linkToken;
    config.fleetV2Scope = { ...config.fleetV2Scope, revision: 2, writeRoots: [] };
    fs.writeFileSync(path.join(scratch, 'host-mode.json'), JSON.stringify(config), { mode: 0o600 });
    const scope = await mode.context.resolveFolderScope();
    assert.deepEqual(scope.writeRoots, []);
    assert.equal(sessions[1].closed, true);
    await assert.rejects(backend.handleLink(secondToken, 'fleet-control', { action: 'read' }), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
    let latest = await mode.host.fleetControl({ action: 'read' }, mode.context.agentSessionId);
    await mode.host.fleetControl({ action: 'permission-profiles', expectedRevision: latest.revision, profiles: { v: 1, activeProfileId: 'restricted', profiles: [
      { id: 'restricted', name: 'Restricted', parentId: null, actions: { agentResume: 'automatic', 'fleet.control': 'disabled' } }
    ] } }, mode.context.agentSessionId);
    latest = await mode.host.fleetControl({ action: 'read' }, mode.context.agentSessionId);
    await mode.host.fleetControl({ action: 'resume', nodeId: worker.nodeId, expectedRevision: latest.revision }, mode.context.agentSessionId);
    assert.equal((await backend.handleLink(sessions[2].spec.linkToken, 'file.access')).permissionProfiles.activeProfileId, 'restricted');
    await assert.rejects(backend.handleLink(sessions[2].spec.linkToken, 'fleet-control', { action: 'ask', id: 'hidden', question: 'Bypass?' }), { code: 'ACTION_PERMISSION_REQUIRED' });

  } finally {
    await mode.close(); require('../src/lib/tree-host-registry').clearTreeSpawnHost();
    fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(runtime, { recursive: true, force: true });
  }
});
test('durable task completion is discoverable and a replacement receives a new task version', async () => {
  const { control, document } = fixture();
  await control.request({ action: 'progress', text: 'Validated inputs' }, 'worker-1');
  assert.equal((await control.request({ action: 'read' }, 'root')).tasks.builder.progress, 'Validated inputs');
  await control.request({ action: 'complete', text: 'Result retained' }, 'worker-1');
  assert.equal(control.assignment('builder').completed, true);
  await assert.rejects(control.request({ action: 'resume', nodeId: 'builder', expectedRevision: 3 }, 'root'), { code: 'FLEET_TASK_COMPLETED' });
  document.nodes[0].state = 'paused';
  await control.request({ action: 'task', nodeId: 'builder', text: 'Next task', expectedRevision: 3 }, 'root');
  assert.equal(control.assignment('builder').taskRevision, 2);
  assert.equal(control.assignment('builder').completed, false);
});
test('a resume queued against the revision before a pause cannot restart the paused worker', async () => {
  const { control, commands, document } = fixture();
  const pause = control.request({ action: 'pause', nodeId: 'builder', expectedRevision: 1 }, 'root');
  const resume = control.request({ action: 'resume', nodeId: 'builder', expectedRevision: 1 }, 'root');
  await pause;
  await assert.rejects(resume, { code: 'FLEET_CONTROL_STALE_REVISION' });
  assert.equal(document.nodes[0].state, 'paused'); assert.equal(commands.length, 1);
});
test('settings writer can clear the documented inheritable model default and rejects fractional fleet limits', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fv2-settings-'));
  const file = path.join(folder, 'settings.json');
  try {
    require('../src/lib/openshell-settings-page').set([['model.local_agent_name', '']], { file });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).values['model.local_agent_name'], '');
    assert.throws(() => require('../src/lib/openshell-settings-page').set([['fleet.max_declared_agents', 1.5]], { file }), { code: 'SETTINGS_PAGE_INVALID' });
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('worker progress receipts do not reveal other workers tasks or asks', async () => {
  const { control } = fixture();
  await control.ensureTask('other', 'Private sibling assignment');
  const receipt = await control.request({ action: 'progress', text: 'Own progress' }, 'worker-1');
  assert.equal(receipt.task.progress, 'Own progress');
  assert.equal(JSON.stringify(receipt).includes('Private sibling assignment'), false);
  assert.equal(receipt.tasks, undefined); assert.equal(receipt.asks, undefined);
});
test('new task identity fences old ask replay and keeps the completed result history', async () => {
  const { control, document } = fixture();
  await control.request({ action: 'ask', id: 'target', question: 'Which target?' }, 'worker-1');
  await control.request({ action: 'answer', id: 'target', answer: 'Old target', expectedRevision: 2 }, 'root');
  await control.request({ action: 'task', nodeId: 'builder', newTask: true, text: 'New task', expectedRevision: 3 }, 'root');
  assert.equal(control.assignment('builder').text.includes('Old target'), false);
  document.nodes[0].state = 'running';
  await assert.rejects(control.request({ action: 'ask', id: 'target', question: 'Which target?' }, 'worker-1'), { code: 'FLEET_ASK_REPLAY_CONFLICT' });
  assert.equal((await control.request({ action: 'read' }, 'root')).taskHistory[0].text, 'Original');
});
