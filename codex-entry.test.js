'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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
test('exact canonical root and a physical alias pass; child, parent and unrelated paths refuse before serving', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-binding-'));
  const project = path.join(fixture, 'project');
  for (const folder of [project, path.join(project, 'child'), path.join(fixture, 'unrelated')]) fs.mkdirSync(folder, { recursive: true });
  const alias = path.join(fixture, 'alias');fs.symlinkSync(project, alias, 'dir');
  const saved = { ...valid, workspace: project };
  for (const selected of [path.join(project, 'child'), fixture, path.join(fixture, 'unrelated')]) {
    let served = false;
    await assert.rejects(main({ env: { ...env, FLEET_MCP_CODEX_WORKSPACE: selected }, readConfig: () => saved,
      serve: () => { served = true; } }), /FLEET_MCP_CODEX_WORKSPACE_REFUSED/);
    assert.equal(served, false, selected);
  }
  for (const selected of [project, alias]) {
    let actual;
    await main({ env: { ...env, FLEET_MCP_CODEX_WORKSPACE: selected }, readConfig: () => saved, serve: config => { actual = config; } });
    assert.equal(actual, saved);
    assert.equal(fs.realpathSync(selected), fs.realpathSync(actual.workspace));
  }
});
