'use strict';
require('./lib/isolated-environment').activate('fleet-v2-observability');
const test = require('node:test'), assert = require('node:assert/strict');
const { createObservability, statusEnabled } = require('../src/lib/fleet-v2-observability');
test('status opt-in uses exact old agent/lane/host precedence and collects nothing when disabled', () => {
  const overrides = [{ kind: 'host', id: 'host', enabled: true }, { kind: 'lane', id: 'lane', enabled: false }, { kind: 'agent', id: 'worker', enabled: true }];
  assert.equal(statusEnabled(false, overrides, { agent: 'worker', lane: 'lane', host: 'host' }), true);
  assert.equal(statusEnabled(false, overrides, { agent: 'other', lane: 'lane', host: 'host' }), false);
  assert.equal(statusEnabled(undefined, overrides, { agent: 'worker' }), false);
  assert.equal(statusEnabled(true, [...overrides, overrides[0]], { agent: 'worker' }), false);
  let reads = 0; const values = { 'agent.status_injection': false, 'agent.status_injection_overrides': [] };
  const observer = createObservability({ document: {}, persist() {}, read: id => values[id], machine: {
    cpus() { reads++; return [{ times: { user: 10, idle: 30 } }]; }, freemem: () => 100, totalmem: () => 200
  } });
  assert.equal(observer.introduction({ nodeId: 'worker' }), ''); assert.equal(reads, 0);
  values['agent.status_injection'] = true;
  assert.match(observer.introduction({ nodeId: 'worker' }), /unknown \(first sample\)/); assert.equal(reads, 1);
});
test('private history sanitizes numeric usage, persists transactionally, and honors disabled history without deleting prior records', () => {
  const document = {}; let enabled = true, fail = false;
  const observer = createObservability({ document, read: () => enabled, persist() { if (fail) throw Error('disk'); } });
  observer.record({ type: 'started', nodeId: 'worker', credentials: 'secret' });
  observer.record({ type: 'usage', nodeId: 'worker', usage: { total: { input_tokens: 10, output_tokens: 2, account: 'secret' }, credentials: 'secret' } });
  assert.equal(observer.history().total, 2); assert.doesNotMatch(JSON.stringify(observer.history()), /secret|credentials|account/);
  enabled = false; observer.record({ type: 'closed' }); assert.equal(observer.history().enabled, false); assert.equal(document.fleetMetrics.entries.length, 2);
  enabled = true; fail = true; assert.throws(() => observer.record({ type: 'closed' }), /disk/); assert.equal(document.fleetMetrics.entries.length, 2);
});
