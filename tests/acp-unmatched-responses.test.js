'use strict';
require('./lib/isolated-environment').activate('acp-unmatched-responses');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AcpAdapter } = require(process.env.ACP_ADAPTER_UNDER_TEST
  ? path.resolve(process.env.ACP_ADAPTER_UNDER_TEST) : '../src/lib/agent-engine/acp-adapter');
const captured = require('./fixtures/acp-unmatched-response.json');

async function start(t) {
  let listener;
  const writes = [], events = [];
  const emit = packet => listener?.(JSON.stringify(packet) + '\n');
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      writes.push(request);
      if (request.method === 'initialize') emit({ jsonrpc: '2.0', id: request.id,
        result: { protocolVersion: 1, agentCapabilities: {} } });
      if (request.method === 'session/new') emit({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'parent' } });
    }
  };
  const adapter = new AcpAdapter({ transport, defaultCwd: process.cwd() });
  t.after(() => adapter.close());
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  await adapter.startThread();
  function turn() {
    const outcome = { settled: false };
    outcome.promise = adapter.sendTurn({ threadId: 'parent', text: 'continue' }).then(
      value => { outcome.settled = true; return { value }; },
      error => { outcome.settled = true; return { error }; });
    outcome.id = writes.at(-1).id;
    return outcome;
  }
  return { adapter, emit, writes, events, turn };
}
async function finish(f, turn) {
  await f.emit({ jsonrpc: '2.0', id: turn.id, result: { stopReason: 'end_turn' } });
  const result = await turn.promise;
  assert.equal(result.error, undefined);
  assert.equal(result.value.stopReason, 'end_turn');
}

test('captured internal reload response cannot end or settle the parent request', async t => {
  const f = await start(t), turn = f.turn();
  const sent = structuredClone(f.writes);
  for (const packet of captured.responses) await f.emit(packet);
  assert.equal(f.adapter.closed, null);
  assert.equal(turn.settled, false);
  assert.deepEqual(f.writes, sent, 'an unsolicited response receives no reply or host action');
  assert.deepEqual(f.events, [], 'an unsolicited response is not parent output');
  await finish(f, turn);
});

test('unknown, already answered, future and differently typed IDs never settle a pending request', async t => {
  const f = await start(t), first = f.turn();
  const futureId = first.id + 1;
  const sent = structuredClone(f.writes);
  for (const packet of [
    { id: String(first.id), result: { stopReason: 'wrong-type' } },
    { id: f.writes[1].id, result: { sessionId: 'duplicate-session' } },
    { id: futureId, result: { stopReason: 'premature' } },
    { id: 'unissued', error: { code: -32000, message: 'not the parent error' } },
    { id: 'unissued-malformed-body', error: { code: 'invalid', message: null } },
    { id: '__proto__', result: {} }
  ]) {
    await f.emit({ jsonrpc: '2.0', ...packet });
    assert.equal(f.adapter.closed, null);
    assert.equal(first.settled, false);
  }
  assert.deepEqual(f.writes, sent);
  await finish(f, first);
  const next = f.turn();
  assert.equal(next.id, futureId, 'the premature response was for this later real request');
  await f.emit({ jsonrpc: '2.0', id: first.id, error: { code: -32603, message: 'late duplicate' } });
  assert.equal(next.settled, false, 'no future response is retained and no old response affects the new turn');
  await finish(f, next);
});

for (const [label, error] of [
  ['noninteger code', { code: 'wrong', message: 'failure' }],
  ['nonstring message', { code: -32603, message: null }],
  ['unsafe error data', { code: -32603, message: 'failure', data: JSON.parse('{"__proto__":{}}') }]
]) test(`a matching response retains strict error validation: ${label}`, async t => {
  const f = await start(t), turn = f.turn();
  await f.emit({ jsonrpc: '2.0', id: turn.id, error });
  assert.equal((await turn.promise).error?.code, 'ACP_PROTOCOL_INVALID');
  assert.equal(f.adapter.closed?.code, 'ACP_PROTOCOL_INVALID');
});

test('a matching valid error rejects only its own request and leaves the next turn usable', async t => {
  const f = await start(t), turn = f.turn();
  await f.emit({ jsonrpc: '2.0', id: turn.id, error: { code: -32603, message: 'requested failure' } });
  const { error } = await turn.promise;
  assert.equal(error?.code, 'ACP_REQUEST_FAILED');
  assert.equal(error.rpcCode, -32603);
  assert.equal(f.adapter.closed, null);
  await finish(f, f.turn());
});

test('a matching success still validates its method-specific result', async t => {
  const f = await start(t), turn = f.turn();
  await f.emit({ jsonrpc: '2.0', id: turn.id, result: { stopReason: 17 } });
  assert.equal((await turn.promise).error?.code, 'ACP_PROTOCOL_INVALID');
});

for (const [label, packet] of [
  ['invalid version', { jsonrpc: '1.0', id: 'foreign', result: {} }],
  ['ambiguous response', { jsonrpc: '2.0', id: 'foreign', result: {}, error: {} }],
  ['invalid ID', { jsonrpc: '2.0', id: {}, result: {} }]
]) test(`the response envelope remains strict: ${label}`, async t => {
  const f = await start(t), turn = f.turn();
  await f.emit(packet);
  assert.equal((await turn.promise).error?.code, 'ACP_PROTOCOL_INVALID');
  assert.equal(f.adapter.closed?.code, 'ACP_PROTOCOL_INVALID');
});
