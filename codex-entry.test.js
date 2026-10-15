'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { coreConfig, main } = require('./codex-entry');
const state = path.resolve('fixture-state'), workspace = path.resolve('fixture-project');
const env = { FLEET_MCP_CODEX_STATE_ROOT: state, FLEET_MCP_CODEX_WORKSPACE: workspace };
const valid = { stateRoot: state, workspace, workers: false, tier: 'standard' };
const real = x => x;
test('valid Standard workers-off core preserves the codex actor', async () => {
  let actual;
  await main({ env, real, readConfig: (root, options) => { assert.equal(root,state);assert.equal(options.setupKind,'plugin');return valid; }, serve: (config, actor) => { actual={config,actor}; } });
  assert.deepEqual(actual,{config:valid,actor:{actor:'codex'}});
});
test('missing or relative configuration refuses before reading state', () => {
  for (const input of [{}, {...env,FLEET_MCP_CODEX_STATE_ROOT:'relative'}, {FLEET_MCP_CODEX_STATE_ROOT:state}])
    assert.throws(() => coreConfig(input,()=>{throw Error('must not read');},real),/CONFIG_REQUIRED/);
});
test('workers and non-Standard tiers refuse before serving', async () => {
  for (const value of [{workers:true},{workers:undefined},{tier:'unrestricted'},{tier:'guided'},{tier:undefined}]) {
    let served=false;
    await assert.rejects(main({env,real,readConfig:()=>({...valid,...value}),serve:()=>{served=true;}}),/WORKERS_REFUSED|TIER_REFUSED/);
    assert.equal(served,false);
  }
});
test('outside projects refuse while a configured descendant is admitted', () => {
  assert.throws(()=>coreConfig(env,()=>({...valid,workspace:workspace+'-other'}),real),/WORKSPACE_REFUSED/);
  assert.equal(coreConfig({...env,FLEET_MCP_CODEX_WORKSPACE:path.join(workspace,'child')},()=>valid,real),valid);
});
