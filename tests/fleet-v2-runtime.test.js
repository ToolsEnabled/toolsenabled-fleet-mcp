'use strict';
require('./lib/isolated-environment').activate('fleet-v2-runtime');
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createOpenShellAgentHost}=require('../src/lib/openshell-agent-host');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-v2-runtime-'));
 const document={v:1,counter:0,nodes:[],inbox:[]},calls=[],sessions=[];
 let revision=1,assignment='task one',hold=null,idx=0;
 const boundary={readRoots:['/'],writeRoots:[root],revision:1,source:'owned-test'};
 const launcher={async start(spec){calls.push(spec);const session={threadId:spec.threadId||`thread-${++idx}`,level:2,
   resolvedSandbox:{type:'dangerFullAccess'}, adapter:{async sendTurn(req){session.turns.push(req);return{threadId:session.threadId,turnId:`turn-${session.turns.length}`}},async interrupt(){}},turns:[],close(){session.closed=true},
   async quiesce(){if(hold)await hold;session.closed=true;session.quiescent=true}}; sessions.push(session);return session;}};
 const env={TOOLSENABLED_RUNTIME_MODE:'host',TOOLSENABLED_HOST_WORKERS:'1',TOOLSENABLED_TOOL_ALLOWLIST:'task.list',TOOLSENABLED_LEVEL_CAP:'2',TOOLSENABLED_FLEET_PROFILE:'fleetV2'};
 const roleHooks={lead:()=>({roleId:'manager',role:{maxLevel:2},surface:{names:['task.list']}}),admitChild:()=>({roleId:'worker',surface:{names:['task.list']}}),brief:({task})=>task,maxLevel:()=>2,removeNativeTools:()=>[]};
 const host=createOpenShellAgentHost({mode:'host',rootSessionId:'owner',workspaceRoot:root,env,launcher,document,roleHooks,folderScope:boundary,
  getAssignment:()=>({revision,text:assignment}),recordAssignment:()=>{},
  baseAllowlist:['task.list'],leadLevel:2,tiers:{fixture:{provider:'codex',tier:'premium',model:'fixture-model'}},limits:{maxClass:'premium',providers:['codex']},slotBounds:{maxChildren:10,maxDepth:5},nodeFolder:id=>path.join(root,id),watchIntervalMs:0,codexEndpoint:()=>null,continuationLedger:()=>[],continuationEnabled:()=>false});
 t.after(async()=>{hold=null;await host.closeAll();fs.rmSync(root,{recursive:true,force:true})});
 return{host,document,calls,sessions,root,boundary,spawn:parent=>host.spawn({parentSessionId:parent?.sessionId||'owner',tier:'fixture',brief:'initial task'}),edit(text){assignment=text;revision++},setHold(p){hold=p}};
}
test('first-row builders and descendants automatically message peers without lifecycle authority',async t=>{
 const f=fixture(t),a=await f.spawn(),b=await f.spawn(),child=await f.spawn(a);
 const context={agentPrincipal:{sessionId:child.sessionId}};
 const roster=await f.host.localComms.roster({},context);
 assert.equal(roster.agents.find(r=>r.agentId===b.nodeId).relation,'linked-peer');
 const sent=await f.host.localComms.send({to:b.nodeId,body:'owned peer update'},context);assert.equal(sent.accepted,true);
 await assert.rejects(f.host.command({parentSessionId:child.sessionId,action:'stop-node',nodeId:b.nodeId}),{code:'MC_TREE_COMMAND_NOT_BELOW_CALLER'});
 await assert.rejects(f.host.localComms.send({to:a.nodeId,body:'direct root bypass'},{agentPrincipal:{sessionId:'owner'}}),{code:'FLEET_ORCHESTRATOR_MESSAGE_REFUSED'});
});
test('pause waits for quiescence, retires token, fences queued resume, and resumes current revision',async t=>{
 const f=fixture(t),a=await f.spawn(),oldToken=f.calls[0].linkToken;
 let release;f.setHold(new Promise(resolve=>release=resolve));
 let settled=false;
 const pause=f.host.command({parentSessionId:'owner',action:'pause-node',nodeId:a.nodeId}).then(v=>{settled=true;return v});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 await assert.rejects(f.host.handleLink(oldToken,'whoami'),{code:'OPENSHELL_TREE_LINK_REFUSED'});
 const stale=f.host.command({parentSessionId:'owner',action:'resume-node',nodeId:a.nodeId});
 const pauseAgain=f.host.command({parentSessionId:'owner',action:'pause-node',nodeId:a.nodeId});
 const rejection=assert.rejects(stale,{code:'FLEET_ACTION_STALE'});
 release();f.setHold(null);assert.equal((await pause).quiescent,true);await rejection;await pauseAgain;
 f.edit('replacement task and current standing rules');
 const resumed=await f.host.command({parentSessionId:'owner',action:'resume-node',nodeId:a.nodeId});
 assert.equal(resumed.resumed,true);assert.match(f.sessions.at(-1).turns[0].text,/replacement task and current standing rules/);
 assert.equal(f.document.nodes[0].assignmentRevision,2);assert.equal(f.document.nodes[0].queue.length,0);
 assert.notEqual(f.calls.at(-1).linkToken,oldToken);
});
test('folder changes quiesce every descendant before publishing scope, then launches inherit exactly',async t=>{
 const f=fixture(t),a=await f.spawn(),b=await f.spawn(a);
 const next={readRoots:['/'],writeRoots:[],revision:2,source:'owned-test-change'};
 const updated=await f.host.updateFolderScope(next);assert.equal(updated.quiescent,true);
 assert.equal(f.sessions.every(s=>s.quiescent),true);assert.deepEqual(updated.pausedNodes.sort(),[a.nodeId,b.nodeId].sort());
 await f.host.command({parentSessionId:'owner',action:'resume-node',nodeId:b.nodeId});
 assert.deepEqual(f.calls.at(-1).folderScope.writeRoots,[]);assert.equal(f.calls.at(-1).folderScope.revision,2);
 await assert.rejects(f.host.updateFolderScope(next),{code:'FLEET_FOLDER_REVISION_STALE'});
});
test('provider bypass settings are selected independently of inherited tool level and parent folder scope',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-v2-launch-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const boundary={readRoots:['/'],writeRoots:[root],revision:1,source:'qualified-fixture'};
 const calls=[];
 const {createHostWorkerLauncher}=require('../src/lib/host-worker-session');
 const launcher=createHostWorkerLauncher({env:{TOOLSENABLED_RUNTIME_MODE:'host',TOOLSENABLED_HOST_WORKERS:'1',TOOLSENABLED_LEVEL_CAP:'2',TOOLSENABLED_TOOL_ALLOWLIST:'task.list'},config:{mode:'host',workers:true,stateRoot:root},workspaceRoot:root,socketPath:path.join(root,'socket'),checkNative:()=>{},agentApiMode:()=> 'Enabled',
  startCodex:async options=>{calls.push(options);assert.deepEqual(require('../src/lib/fleet-folder-scope').current(),boundary);return{threadId:'owned-thread',resolvedSandbox:{type:'dangerFullAccess'},close(){}}}});
 const spec={fleetV2:true,folderScope:boundary,provider:'codex',level:2,nodeId:'owned-node',sessionId:'owned-session',nodeFolder:path.join(root,'node'),linkToken:'synthetic-test-token',removeNativeTools:[],serverEnv:{TOOLSENABLED_TOOL_ALLOWLIST:'task.list'},onEvent:()=>{}};
 const session=await launcher.start(spec);
 assert.equal(session.level,2);assert.equal(calls[0].threadOptions.approvalPolicy,'never');assert.equal(calls[0].threadOptions.sandbox,'danger-full-access');
 assert.equal(require('../src/lib/fleet-folder-scope').current(),null);
 await assert.rejects(launcher.start({...spec,folderScope:null}),{code:'FLEET_FOLDER_SCOPE_UNAVAILABLE'});
});
test('failed quiescence retains custody and blocks resume and removal until stop proves cleanup',async t=>{
 const f=fixture(t),a=await f.spawn();const session=f.sessions[0],cleanup=session.quiesce;
 session.quiesce=async()=>{throw Object.assign(Error('owned synthetic cleanup failure'),{code:'FLEET_QUIESCENCE_UNPROVEN'})};
 await assert.rejects(f.host.command({parentSessionId:'owner',action:'pause-node',nodeId:a.nodeId}),{code:'FLEET_QUIESCENCE_UNPROVEN'});
 await assert.rejects(f.host.command({parentSessionId:'owner',action:'resume-node',nodeId:a.nodeId}),{code:'MC_TREE_COMMAND_RESUME_REFUSED'});
 await assert.rejects(f.host.command({parentSessionId:'owner',action:'remove-node',nodeId:a.nodeId}),{code:'MC_TREE_COMMAND_REMOVE_REFUSED'});
 session.quiesce=cleanup;
 const stopped=await f.host.command({parentSessionId:'owner',action:'stop-node',nodeId:a.nodeId});assert.equal(stopped.stopped,true);assert.equal(session.quiescent,true);
});
