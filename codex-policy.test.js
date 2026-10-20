'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const allowed = require('./.codex-plugin/policy.json').allowedTools;

test('installed OpenAI entry enforces the reviewed ceiling on list and direct calls', {timeout:20000}, async t => {
  const fixture = fs.mkdtempSync(path.join(os.homedir(),'fleet-plugin-policy-'));
  const workspace = path.join(fixture,'project'), state = path.join(fixture,'state');
  fs.mkdirSync(workspace);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('TOOLSENABLED_')));
  delete env.OPENSHELL_SANDBOX;
  Object.assign(env,{FLEET_MCP_CODEX_STATE_ROOT:state,FLEET_MCP_CODEX_WORKSPACE:workspace});
  const setup = spawnSync(process.execPath,[path.join(__dirname,'bin/toolsenabled-host.js'),
    'setup','--plugin','--workspace',workspace,'--tier','standard','--state-root',state],
    {env,cwd:__dirname,encoding:'utf8',timeout:10000});
  assert.equal(setup.status,0,setup.stderr);
  const child = spawn(process.execPath,[path.join(__dirname,'codex-entry.js')],{env,cwd:workspace,stdio:['pipe','pipe','pipe']});
  let errors='',next=0;
  child.stderr.on('data',data=>{errors+=data;});
  const pending = new Map();
  const lines = readline.createInterface({input:child.stdout});
  lines.on('line',line=>{const answer=JSON.parse(line);pending.get(answer.id)?.(answer);pending.delete(answer.id);});
  const closed = new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{
    child.stdin.end();
    const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
    await closed;clearTimeout(timer);lines.close();
    fs.rmSync(fixture,{recursive:true,force:true});
  });
  const call = (method,params={}) => new Promise(resolve=>{
    const id=++next;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  const initialized=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'policy-test',version:'1'}});
  assert.ok(initialized.result,errors);
  const listed=await call('tools/list');
  assert.ok(listed.result?.tools.length>0,JSON.stringify(listed));
  assert.equal(allowed.length,27);
  for(const tool of listed.result.tools) {
    assert.ok(allowed.includes(tool.name),tool.name);
    for(const hint of ['readOnlyHint','destructiveHint','openWorldHint']) assert.equal(typeof tool.annotations[hint],'boolean',tool.name+' '+hint);
  }
  for(const name of ['task.list','system.status']) {
    assert.ok(listed.result.tools.some(tool=>tool.name===name),name);
    const answer=await call('tools/call',{name,arguments:{}});
    assert.ok(answer.result && !answer.result.isError,JSON.stringify(answer));
  }
  // Existing host tools outside the plugin, not merely nonexistent names.
  for(const name of ['settings.read','system.doctor','audit.status','r_ledger.file','agent.spawn','host.exec','future.history.extract']) {
    assert.ok(!listed.result.tools.some(tool=>tool.name===name),name);
    const answer=await call('tools/call',{name,arguments:{}});
    assert.ok(answer.error || answer.result?.isError,JSON.stringify(answer));
  }
});
