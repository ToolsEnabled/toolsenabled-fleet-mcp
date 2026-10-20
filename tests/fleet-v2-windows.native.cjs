'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
assert.equal(process.platform,'win32');
const root=process.env.FLEET_V2_NATIVE_ROOT||path.resolve(__dirname,'..');
const {spawnInJob}=require(path.join(root,'src/lib/windows-job-control'));
const fixture=fs.mkdtempSync(path.join(root,'owned-')),allowed=path.join(fixture,'allowed'),denied=path.join(fixture,'denied');
fs.mkdirSync(allowed);fs.mkdirSync(denied);fs.writeFileSync(path.join(denied,'keep'),'ORIGINAL');
fs.symlinkSync(denied,path.join(allowed,'escape'),'junction');
const acl=p=>{const q=p.replaceAll("'","''");const r=cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Acl -LiteralPath '${q}').Sddl`],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
async function launch(scope,script){
 const child=spawnInJob(process.execPath,['-e',script],{cwd:fixture,env:process.env,stdio:['pipe','pipe','pipe'],folderScope:scope,terminateDescendantsOnRootExit:true},
  {safeLaunchEnvironment:e=>e,recordDirectory:path.join(fixture,'jobs'),assemblyCacheDirectory:null,handshakeTimeoutMs:30000,cleanupTimeoutMs:15000});
 let output='',stderr='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);let cause=null;child.on('error',e=>{cause=e});child.stdin.end();
 const deadline=setTimeout(()=>child.terminateJob().catch(()=>{}),15000);
 const result=await child.jobOutcome;await child.jobClosed;clearTimeout(deadline);
 assert.equal(result.activeProcesses,0,JSON.stringify({result,cause:cause?.message,stderr,output}));
 return{result,output,stderr,cause};
}
(async()=>{
 const before=acl(allowed);
 const inner=`const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(path.join(denied,'grandchild'))},'bad');process.exit(72)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}fs.writeFileSync(${JSON.stringify(path.join(allowed,'grandchild'))},'good');`;
 const script=`const fs=require('fs'),cp=require('child_process');fs.writeFileSync(${JSON.stringify(path.join(allowed,'ok'))},'yes');
 for(const target of ${JSON.stringify([path.join(denied,'bad'),path.join(allowed,'escape','bad')])}){try{fs.writeFileSync(target,'bad');process.exit(71)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}}
 try{fs.truncateSync(${JSON.stringify(path.join(denied,'keep'))},0);process.exit(73)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}
 const child=cp.spawnSync(process.execPath,['-e',${JSON.stringify(inner)}],{stdio:'inherit',timeout:5000,windowsHide:true});if(child.status!==0){console.error(child.stderr,child.error);process.exit(74)}console.log('native-enforced');`;
 const result=await launch({readRoots:[],writeRoots:[allowed],readAll:true,revision:1,source:'owned-native-fixture'},script);
 assert.equal(result.result.exitCode,0,JSON.stringify(result));assert.match(result.output,/native-enforced/);
 assert.equal(fs.readFileSync(path.join(denied,'keep'),'utf8'),'ORIGINAL');assert.equal(fs.existsSync(path.join(denied,'bad')),false);assert.equal(fs.existsSync(path.join(denied,'grandchild')),false);
 assert.equal(fs.readFileSync(path.join(allowed,'grandchild'),'utf8'),'good');assert.equal(acl(allowed).replace('D:AI','D:'),before.replace('D:AI','D:'),'unique scoped ACE must be removed without changing unrelated permission entries');
 const knownSids=before.match(/S-1-5-21-(?:\d+-){3}\d+/g)||[];
 const aclSaved=path.join(allowed,'saved-acl');
 const escapeScript=`const cp=require('child_process'),fs=require('fs');let r=cp.spawnSync('icacls.exe',[${JSON.stringify(allowed)},'/save',${JSON.stringify(aclSaved)}],{stdio:'inherit',windowsHide:true});if(r.status!==0)process.exit(78);const text=fs.readFileSync(${JSON.stringify(aclSaved)}).toString('utf16le');const sid=(text.match(/S-1-5-21-(?:\\d+-){3}\\d+/g)||[]).find(s=>!${JSON.stringify(knownSids)}.includes(s));if(!sid)process.exit(79);r=cp.spawnSync('icacls.exe',[${JSON.stringify(denied)},'/grant','*'+sid+':(OI)(CI)F'],{stdio:'inherit',windowsHide:true});try{fs.writeFileSync(${JSON.stringify(path.join(denied,'dacl-escape'))},'BAD');process.exit(77)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}console.log('outside-dacl-escape-denied')`;
 const daclTest=await launch({readRoots:[],writeRoots:[allowed],readAll:true,revision:2,source:'owned-native-fixture'},escapeScript);
 assert.equal(daclTest.result.exitCode,0,JSON.stringify(daclTest));assert.equal(fs.existsSync(path.join(denied,'dacl-escape')),false,'restricted process must not rewrite outside-owned DACL to escape');
 const empty=await launch({readRoots:[],writeRoots:[],readAll:true,revision:2,source:'owned-native-fixture'},`const fs=require('fs');fs.readFileSync(${JSON.stringify(path.join(denied,'keep'))});try{fs.writeFileSync(${JSON.stringify(path.join(allowed,'empty-denied'))},'bad');process.exit(75)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}console.log('empty-write-denied')`);
 assert.equal(empty.result.exitCode,0,JSON.stringify(empty));assert.match(empty.output,/empty-write-denied/);
 const ticks=path.join(allowed,'ticks');
 const active=spawnInJob(process.execPath,['-e',`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(ticks)},'x'),10)`],{cwd:fixture,env:process.env,stdio:['pipe','pipe','pipe'],folderScope:{readRoots:[],writeRoots:[allowed],readAll:true,revision:3,source:'owned-native-fixture'},terminateDescendantsOnRootExit:true},{safeLaunchEnvironment:e=>e,recordDirectory:path.join(fixture,'jobs'),assemblyCacheDirectory:null});
 active.on('error',()=>{});active.stdout.resume();active.stderr.resume();active.stdin.end();
 const timeout=Date.now()+10000;while(!fs.existsSync(ticks)){if(Date.now()>timeout){await active.terminateJob();throw Error('owned native ticking process did not start')}await new Promise(r=>setTimeout(r,20));}
 const stopped=await active.terminateJob();await active.jobClosed;assert.equal(stopped.activeProcesses,0);
 const written=fs.readFileSync(ticks);await new Promise(r=>setTimeout(r,150));assert.deepEqual(fs.readFileSync(ticks),written);
 console.log(JSON.stringify({nativeWindows:true,scope:'explicit-readAll-write-selected',allowedWrite:true,siblingWriteDenied:true,junctionEscapeDenied:true,truncateDenied:true,grandchildInherited:true,cleanupRestored:true,daclEscapeDenied:true,emptyWriteScopeDenied:true,quiescent:true,activeProcesses:0,fixture}));
})().catch(e=>{console.error(e);process.exitCode=1});
