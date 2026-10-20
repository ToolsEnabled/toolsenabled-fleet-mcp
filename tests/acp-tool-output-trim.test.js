'use strict';
require('./lib/isolated-environment').activate('acp-tool-output-trim');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../src/lib/agent-engine/acp-adapter');

// _toolUpdatePayload reads only the field descriptors it is handed.
const payloadOf = fields => AcpAdapter.prototype._toolUpdatePayload(
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])));
const lines = count => Array.from({ length: count }, (_, index) => `line ${index}`);

test('a tool output longer than the bound is trimmed and marked, not refused', () => {
  for (const key of ['rawOutput', 'content']) {
    const payload = payloadOf({ [key]: key === 'rawOutput' ? { stdout: lines(10_001) } : lines(10_001) });
    const kept = key === 'rawOutput' ? payload.rawOutput.stdout : payload.content;
    assert.equal(kept.length, 10_000);
    assert.equal(kept.at(-1), 'line 9999');
    assert.equal(payload.truncated, true);
  }
});

test('a tool output within the bound is unchanged and unmarked', () => {
  const payload = payloadOf({ rawOutput: { stdout: lines(10_000) }, title: 'run' });
  assert.equal(payload.rawOutput.stdout.length, 10_000);
  assert.equal(payload.title, 'run');
  assert.equal(payload.truncated, undefined);
});

test('a tool-update field that is not output keeps the strict bound', () => {
  assert.throws(() => payloadOf({ locations: lines(10_001) }),
    error => error.code === 'ACP_PROTOCOL_INVALID' && /too many entries/.test(error.message));
});

test('trimming never relaxes the nesting bound on tool output', () => {
  let deep = 'x';
  for (let index = 0; index < 40; index += 1) deep = [deep];
  assert.throws(() => payloadOf({ rawOutput: { stdout: deep } }),
    error => error.code === 'ACP_PROTOCOL_INVALID' && /too deeply nested/.test(error.message));
});
