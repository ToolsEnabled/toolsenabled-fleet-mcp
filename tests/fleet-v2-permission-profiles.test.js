'use strict';
require('./lib/isolated-environment').activate('fleet-v2-permission-profiles');
const test = require('node:test'), assert = require('node:assert/strict');
const profiles = require('../src/lib/action-permission-profiles');
const saved = { v: 1, activeProfileId: 'worker', profiles: [
  { id: 'base', name: 'Base', parentId: null, actions: { agentResume: 'automatic' }, functions: ['settings.read', 'agent_comms.send_local'] },
  { id: 'worker', name: 'Worker', parentId: 'base', actions: { 'agent_comms.send_local': 'disabled' } }
] };
test('old saved profile inheritance narrows workers independently of root authority', () => {
  const rootDefault = { v: 1, activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', parentId: null, actions: { agentResume: 'automatic' } }] };
  profiles.installHost({ readSaved: () => rootDefault, readSavedForPrincipal: principal => principal.sessionId === 'root' ? rootDefault : saved,
    isDirectUserTurn: () => false, hasInheritedUserPermission: () => false });
  assert.equal(profiles.assertAction({ name: 'agent.resume' }, { sessionId: 'root' }), true);
  assert.throws(() => profiles.assertAction({ name: 'agent_comms.send_local' }, { sessionId: 'worker' }), { code: 'ACTION_PERMISSION_REQUIRED' });
  assert.throws(() => profiles.assertAction({ name: 'host.write_file' }, { sessionId: 'worker' }), { code: 'ACTION_PERMISSION_REQUIRED' });
  assert.equal(profiles.narrowTools([{ name: 'agent_comms.send_local' }]).length, 1);
});
test('actual old mc.action-permissions.v1 import validates full profiles and cycles', () => {
  const { prepareImport } = require('../src/lib/fleet-v2-settings');
  assert.equal(prepareImport({ 'mc.action-permissions.v1': JSON.stringify(saved) }).permissionProfiles.activeProfileId, 'worker');
  const cyclic = JSON.parse(JSON.stringify(saved)); cyclic.profiles[0].parentId = 'worker';
  assert.throws(() => prepareImport({ 'mc.action-permissions.v1': cyclic }), { code: 'ACTION_PERMISSION_PROFILE_INVALID' });
});
test('MCP discovery refreshes authenticated worker profiles before enumerating or dispatching', async () => {
  const { dispatch } = require('../src/mcp-server');
  const hosts = require('../src/lib/tree-host-registry');
  hosts.installTreeSpawnHost({ spawn() {}, isTreeSession() {}, fleetControlVersion: 1, fleetControl() {} });
  let current = null, reads = 0;
  profiles.installHost({ readSaved: () => current, isDirectUserTurn: () => false, hasInheritedUserPermission: () => false });
  const context = { permissionSession: require('../src/lib/permission-tier-policy').installTierSession('standard'),
    resolvePermissionProfiles: async () => { reads++; current = saved; } };
  try {
    const result = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, context);
    assert.equal(reads, 1);
    assert.deepEqual(result.tools.map(tool => tool.name), ['settings.read']);
    await assert.rejects(dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent_comms.send_local', arguments: { to: 'other', body: 'No' } } }, context), { code: -32602 });
    assert.equal(reads, 2);
  } finally { hosts.clearTreeSpawnHost(); profiles.installHost({ readSaved: () => null, isDirectUserTurn: () => false, hasInheritedUserPermission: () => false }); }
});
