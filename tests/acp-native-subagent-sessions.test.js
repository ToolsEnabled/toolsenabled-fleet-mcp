'use strict';
require('./lib/isolated-environment').activate('acp-native-subagent-sessions');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../src/lib/agent-engine/acp-adapter');

const update = (sessionId, body) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
const thought = text => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const said = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const settle = () => new Promise(resolve => setImmediate(resolve));

// An agent that keeps its own sub-agents (Grok) streams each child's updates
// over the same connection, under a session id the child opened itself.
async function start(t, duringPrompt) {
  let listener;
  const writes = [];
  const emit = packet => listener?.(JSON.stringify(packet) + '\n');
  const transport = {
    onData(fn) { listener = fn; return () => { listener = null; }; },
    write(line) {
      const request = JSON.parse(line);
      writes.push(request);
      if (request.method === 'initialize') emit({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (request.method === 'session/new') emit({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'parent' } });
      if (request.method === 'session/prompt') {
        for (const packet of duringPrompt) emit(packet);
        emit({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
      }
    }
  };
  const adapter = new AcpAdapter({ transport, defaultCwd: process.cwd() });
  t.after(() => adapter.close());
  const events = [];
  adapter.onEvent(event => events.push(event));
  await adapter.initialize();
  await adapter.startThread();
  return { adapter, emit, events, writes };
}

test("a native sub-agent's thinking, text and tool calls do not end the parent's turn", async t => {
  const { adapter, events } = await start(t, [
    update('parent', thought('planning')),
    update('child-1', thought('child thinking')),
    update('child-1', said('child text')),
    update('child-1', { sessionUpdate: 'tool_call', toolCallId: 'child-one', title: 'web_fetch', status: 'completed' }),
    update('child-2', { sessionUpdate: 'tool_call_update', toolCallId: 'never-announced', status: 'completed' }),
    update('parent', said('parent answer'))
  ]);
  const result = await adapter.sendTurn({ threadId: 'parent', text: 'go' });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(adapter.closed, null);
  // Nothing from a child is shown as the parent's own output.
  const shown = JSON.stringify(events);
  assert.ok(shown.includes('parent answer'));
  for (const childText of ['child thinking', 'child text', 'web_fetch']) assert.ok(!shown.includes(childText), childText);
  assert.ok(events.every(event => event.threadId === undefined || event.threadId === 'parent'));
});

test("a native sub-agent's permission request is declined, never granted", async t => {
  const { adapter, writes } = await start(t, [{
    jsonrpc: '2.0', id: 'child-ask', method: 'session/request_permission',
    params: { sessionId: 'child-1', toolCall: { toolCallId: 'child-two' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] }
  }]);
  await adapter.sendTurn({ threadId: 'parent', text: 'go' });
  const answer = writes.find(write => write.id === 'child-ask');
  assert.deepEqual(answer.result, { outcome: { outcome: 'cancelled' } });
});

test('a session the adapter opened still may not stream outside a prompt', async t => {
  const { adapter, emit } = await start(t, []);
  await adapter.sendTurn({ threadId: 'parent', text: 'go' });
  emit(update('parent', thought('late')));
  await settle();
  assert.equal(adapter.closed?.code, 'ACP_PROTOCOL_INVALID');
  assert.match(adapter.closed.message, /thinking outside an active prompt/);
});
