'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceGate, validatePolicy, DEFAULT_SETTINGS } = require('../src/lib/fleet-v2-resources');
const GiB = 1024 ** 3;
function fixture(overrides = {}) {
  let time = 0, cpu = 10, free = 16 * GiB;
  let policy = validatePolicy({ mode: 'mechanical', maxConcurrentStarts: 1, ...overrides });
  const gate = createResourceGate({ rootSessionId: 'root', settings: () => policy, now: () => time, intervalMs: 0,
    sample: () => ({ atMs: time, cpuPercent: cpu, freeBytes: free, totalBytes: 32 * GiB, loopLagMs: 0 }) });
  return { gate, tick(value) { time = value; gate.tick(); }, setCpu(value) { cpu = value; }, setFree(value) { free = value; }, setPolicy(value) { policy = validatePolicy(value); } };
}
test('exact old resource controls validate and invalid control relationships never fall back silently', () => {
  assert.equal(validatePolicy({}).mode, 'off');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) assert.deepEqual(validatePolicy({ [key]: value })[key], value);
  assert.throws(() => validatePolicy({ cpuCeilingPercent: 80, cpuBusyPercent: 90 }), { code: 'FLEET_RESOURCE_POLICY_INVALID' });
  assert.throws(() => validatePolicy({ maxConcurrentStarts: 0 }), { code: 'FLEET_RESOURCE_POLICY_INVALID' });
  assert.throws(() => validatePolicy({ providerBytes: { fake: GiB } }), { code: 'FLEET_RESOURCE_POLICY_INVALID' });
});
test('mechanical mode blocks warming, RAM pressure, concurrent starts and pacing before launcher execution', async () => {
  const f = fixture(); let calls = 0, finish;
  const launch = async () => { calls++; return {}; };
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_RESOURCE_UNKNOWN' });
  f.tick(0); f.tick(1000);
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_RESOURCE_WARMING' });
  f.tick(2000); f.setFree(GiB); f.tick(3000);
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_MEMORY_LOW' });
  f.setFree(16 * GiB); f.tick(4000);
  const pending = f.gate.start({ provider: 'codex' }, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_RESOURCE_STARTS_BUSY' });
  assert.equal(calls, 1);
  finish({ ready: true }); await pending;
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_RESOURCE_PACING' });
  f.tick(9000);
  await f.gate.start({ provider: 'codex' }, launch);
  assert.equal(calls, 2); f.gate.close();
});
test('controller allowance is root-bound, expires and stable advice replay never refills credit', async () => {
  const f = fixture({ mode: 'controller' }); let calls = 0;
  const launch = async () => { calls++; return {}; };
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_RESOURCE_CONTROLLER_UNKNOWN' });
  const advice = { id: 'one', provider: 'codex', decision: 'allow', launches: 1, expiresAtMs: 10000 };
  f.gate.advise(advice);
  await f.gate.start({ provider: 'codex' }, launch);
  f.gate.advise(advice);
  await assert.rejects(f.gate.start({ provider: 'codex' }, launch), { code: 'AGENT_RESOURCE_CONTROLLER_UNKNOWN' });
  assert.equal(calls, 1);
  f.tick(11000);
  assert.throws(() => f.gate.advise(advice), { code: 'FLEET_RESOURCE_ADVICE_INVALID' });
  f.gate.close();
});
test('import recognizes actual mc.resources.v1 and skips excluded settings without echoing raw values', () => {
  const { prepareImport } = require('../src/lib/fleet-v2-settings');
  const prepared = prepareImport({ 'mc.resources.v1': JSON.stringify({ mode: 'mechanical', reserveBytes: GiB }), 'model.api_key': 'never-return-this' });
  assert.equal(prepared.resources.mode, 'mechanical'); assert.equal(prepared.resources.reserveBytes, GiB);
  assert.equal(prepared.skipped[0].id, 'model.api_key');
  assert.equal(JSON.stringify(prepared).includes('never-return-this'), false);
});
