'use strict';
require('./lib/isolated-environment').activate('agy-mcp-client');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const agents=require('../src/lib/agents/registry'),registration=require('../src/lib/agents/registration');
const engine=path.resolve(__dirname,'..'),cli=path.join(engine,'bin/fleetV2.js');
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(),'fleet-agy-client-test-')));fs.chmodSync(root,0o700);fs.mkdirSync(path.join(root,'workspace'),{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return{root,workspace:path.join(root,'workspace'),state:path.join(root,'state')}}
function envFor(home){return{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('TOOLSENABLED_')&&key!=='OPENSHELL_SANDBOX')),HOME:home,USERPROFILE:home}}
function setup(f,actor='agy',workers=false){return cp.spawnSync(process.execPath,[cli,'setup','--state-root',f.state,'--workspace',f.workspace,...(workers?[]:['--coordination-only']),'--actor',actor],{env:envFor(f.root),cwd:f.workspace,encoding:'utf8',windowsHide:true,timeout:120000})}
test('bundled AGY descriptor identifies an official MCP client without enabling its held worker',()=>{
 const loaded=agents.loadRegistry({userDir:null}),agy=loaded.get('agy');assert.ok(agy);assert.equal(agy.command,'agy');assert.ok(agents.actorNames(loaded).includes('agy'));assert.equal(agents.workerAgentIds(loaded).includes('agy'),false);assert.throws(()=>agents.assertWorkerAvailable(loaded,'agy'),{code:'AGENT_WORKER_HELD'});
 assert.equal(agy.register.kind,'command');assert.equal(agy.register.profile.default,'.gemini/config');assert.equal(agy.register.profile.file,'mcp_config.json');
});
test('AGY registration uses its documented command order, config path and exact actor binding',t=>{
 const f=fixture(t),loaded=agents.loadRegistry({userDir:null}),agy=loaded.get('agy'),env=envFor(f.root),calls=[];
 const entry={command:process.execPath,args:[cli,'serve','--state-root',f.state],env:{TOOLSENABLED_RUNTIME_MODE:'host'}};
 const added=registration.add(agy,entry,{env,registry:loaded,name:'fleetv2-owned',actorInArgs:true,launch:(command,args,options)=>{calls.push({command,args,options});return{status:0}}});
 assert.equal(added,'added');assert.equal(calls.length,1);assert.equal(calls[0].command,'agy');assert.deepEqual(calls[0].args,['mcp','add','--env','TOOLSENABLED_RUNTIME_MODE=host','fleetv2-owned','--',process.execPath,...entry.args,'--actor','agy']);assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.shell,false);
 assert.equal(registration.profile(agy,env).file,path.join(f.root,'.gemini','config','mcp_config.json'));
});
test('setup and status retain selected AGY actor; unknown actors fail before state creation',t=>{
 const f=fixture(t),result=setup(f);assert.equal(result.status,0,result.stderr);const answer=JSON.parse(result.stdout);assert.deepEqual(answer.server.args.slice(-2),['--actor','agy']);assert.equal(JSON.parse(fs.readFileSync(path.join(f.state,'host-mode.json'))).leadActor,'agy');
 const status=cp.spawnSync(process.execPath,[cli,'status','--state-root',f.state],{env:envFor(f.root),encoding:'utf8',windowsHide:true});assert.equal(status.status,0,status.stderr);assert.deepEqual(JSON.parse(status.stdout).server.args.slice(-2),['--actor','agy']);
 const other={...f,state:path.join(f.root,'invalid-state')},bad=setup(other,'not-a-client');assert.equal(bad.status,1);assert.match(bad.stderr,/FLEET_V2_ACTOR_INVALID/);assert.equal(fs.existsSync(other.state),false);
});
test('fresh package AGY actor completes MCP initialize, discovery and durable control without inference',async t=>{
 const f=fixture(t),result=setup(f,'agy',true);assert.equal(result.status,0,result.stderr);const entry=JSON.parse(result.stdout).server;
 const child=cp.spawn(entry.command,entry.args,{env:envFor(f.root),cwd:f.workspace,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='',stderr='',seq=0;const pending=new Map();let exited=false;
 child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16384)});child.on('error',e=>{for(const p of pending.values())p.reject(e)});child.on('exit',()=>{exited=true;for(const p of pending.values())p.reject(Error('MCP ended: '+stderr))});
 child.stdout.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;let reply;try{reply=JSON.parse(line)}catch{continue}const p=pending.get(reply.id);if(p){pending.delete(reply.id);clearTimeout(p.timer);reply.error?p.reject(Error(JSON.stringify(reply.error))):p.resolve(reply.result)}}});
 async function call(method,params){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP timeout '+method+': '+stderr))},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}
 t.after(async()=>{child.stdin.end();if(!exited)await new Promise(resolve=>{const timer=setTimeout(()=>{if(!exited)child.kill();resolve()},3000);child.once('exit',()=>{clearTimeout(timer);resolve()})})});
 const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'agy-owned-no-inference-test',version:'1'}});assert.equal(typeof init.serverInfo.name,'string');child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await call('tools/list',{});assert.ok(list.tools.some(row=>row.name==='fleet.control'));
 const rule=await call('tools/call',{name:'fleet.control',arguments:{action:'rule',id:'agy-owned-rule',text:'Owned no-inference AGY MCP proof.',expectedRevision:0}});assert.notEqual(rule.isError,true,JSON.stringify(rule));
 const read=await call('tools/call',{name:'fleet.control',arguments:{action:'read'}});assert.notEqual(read.isError,true,JSON.stringify(read));assert.ok(read.content?.length);assert.match(JSON.stringify(read),/agy-owned-rule/);
});
