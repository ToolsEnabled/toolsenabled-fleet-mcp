'use strict';
require('./lib/isolated-environment').activate('fleet-v2-message-runtime');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOpenShellAgentHost } = require('../src/lib/openshell-agent-host');
function fixture(t, policy) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fv2-msg-'))), sessions = [];
  let taskRevision = 1, turnId = 0;
  const host = createOpenShellAgentHost({ mode: 'host', fleetV2: true, rootSessionId: 'owner', workspaceRoot: root,
    env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' },
    folderScope: { readRoots: [root], writeRoots: [root], revision: 1, source: 'test-parent' },
    baseAllowlist: ['task.list'], leadLevel: 2, watchIntervalMs: 0, codexEndpoint: () => null,
    tiers: { fixture: { provider: 'codex', tier: 'premium', model: 'fixture' } }, limits: { maxClass: 'premium', providers: ['codex'] },
    slotBounds: { maxChildren: 10, maxDepth: 5 }, continuationLedger: () => [], continuationEnabled: () => false,
    roleHooks: { lead: () => ({ roleId: 'manager', surface: { names: ['task.list'] } }), maxLevel: () => 2,
      admitChild: () => ({ roleId: 'worker', surface: { names: ['task.list'] } }), brief: ({ task }) => task, removeNativeTools: () => [] },
    getMessagePolicy: () => policy, getAssignment: () => ({ revision: taskRevision, taskRevision, text: `Task ${taskRevision}` }), recordAssignment() {},
    launcher: { async start(spec) {
      const session = { spec, threadId: spec.threadId || `thread-${sessions.length}`, turns: [], steers: [],
        adapter: { async sendTurn(turn) { session.turns.push(turn); session.turnId = `turn-${++turnId}`; return { threadId: session.threadId, turnId: session.turnId }; },
          async steerTurn(turn) { session.steers.push(turn); return { threadId: turn.threadId, turnId: turn.turnId }; }, async interrupt() {} },
        close() {}, async quiesce() { session.closed = true; },
        finish() { spec.onEvent({ type: 'turn_completed', threadId: session.threadId, turnId: session.turnId, status: 'completed' }); } };
      sessions.push(session); return session;
    } } });
  t.after(async () => { await host.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });
  return { host, sessions, policy, nextTask() { taskRevision++; }, spawn: () => host.spawn({ parentSessionId: 'owner', tier: 'fixture', brief: 'Initial' }),
    async boundary(worker, id) { const begin = await host.controlBoundary({ parentSessionId: worker.sessionId, phase: 'begin', requestId: id });
      return host.controlBoundary({ parentSessionId: worker.sessionId, phase: 'end', boundaryId: begin.boundaryId }); } };
}
test('End of turn keeps live messages queued and delivers after completion', async t => {
  const f = fixture(t, { mode: 'end-of-turn', intervalMs: 1000, resetAfterTask: true });
  const a = await f.spawn(), b = await f.spawn();
  await f.host.localComms.send({ to: b.nodeId, body: 'Peer result' }, { agentPrincipal: { sessionId: a.sessionId } });
  assert.equal((await f.boundary(b, 'before-completion')).reason, 'message-delivery-policy');
  assert.equal(f.sessions[1].steers.length, 0); assert.equal(f.sessions[1].turns.length, 1);
  f.sessions[1].finish();
  for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sessions[1].turns.length, 2); assert.match(f.sessions[1].turns[1].text, /Peer result/);
});
test('Timer defers live steering until first-arrival interval expires without interrupting', async t => {
  const f = fixture(t, { mode: 'timer', intervalMs: 200, resetAfterTask: true });
  const a = await f.spawn(), b = await f.spawn();
  await f.host.localComms.send({ to: b.nodeId, body: 'Batch first' }, { agentPrincipal: { sessionId: a.sessionId } });
  assert.equal((await f.boundary(b, 'early')).reason, 'message-delivery-policy');
  await new Promise(resolve => setTimeout(resolve, 220));
  const result = await f.boundary(b, 'due');
  assert.equal(result.status, 'accepted'); assert.equal(f.sessions[1].steers.length, 1);
  assert.equal(f.sessions[1].turns.length, 1); assert.match(f.sessions[1].steers[0].text, /Batch first/);
});
test('task reset setting preserves or replaces provider conversation only when task identity changes', async t => {
  const f = fixture(t, { mode: 'instant', intervalMs: 1000, resetAfterTask: false });
  const worker = await f.spawn(); const firstThread = f.sessions[0].threadId;
  await f.host.command({ action: 'pause-node', nodeId: worker.nodeId, parentSessionId: 'owner' });
  f.nextTask();
  await f.host.command({ action: 'resume-node', nodeId: worker.nodeId, parentSessionId: 'owner' });
  assert.equal(f.sessions[1].spec.threadId, firstThread);
  await f.host.command({ action: 'pause-node', nodeId: worker.nodeId, parentSessionId: 'owner' });
  f.nextTask(); f.policy.resetAfterTask = true;
  await f.host.command({ action: 'resume-node', nodeId: worker.nodeId, parentSessionId: 'owner' });
  assert.equal(f.sessions[2].spec.threadId, null); assert.notEqual(f.sessions[2].threadId, firstThread);
});
