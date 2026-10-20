'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scope = require('../src/lib/fleet-folder-scope');
const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
async function run(boundary, code, cwd) {
  const child = scope.run(boundary, () => spawnHidden(process.execPath, ['-e', code],
    { cwd, env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe','pipe','pipe'] }));
  const out = [], err = []; child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
  child.on('error', () => {}); child.stdin.end();
  const outcome = await child.jobOutcome;
  await child.jobClosed;
  assert.equal(outcome.activeProcesses, 0, JSON.stringify(outcome));
  return { code: outcome.exitCode, output: Buffer.concat(out).toString(), error: Buffer.concat(err).toString() };
}
test('kernel scope restricts actual shell descendants, symlinks, truncation and rename while preserving allowed writes', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v2-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed'), denied = path.join(root, 'denied');
  fs.mkdirSync(allowed); fs.mkdirSync(denied); fs.writeFileSync(path.join(denied, 'keep'), 'ORIGINAL');
  fs.symlinkSync(denied, path.join(allowed, 'alias'));
  const boundary = { readRoots: ['/'], writeRoots: [allowed], revision: 1, source: 'owned-fixture' };
  const code = `const fs=require('fs'),cp=require('child_process');
    fs.writeFileSync(${JSON.stringify(path.join(allowed,'ok'))},'yes');
    const attempts=[()=>fs.writeFileSync(${JSON.stringify(path.join(denied,'bad'))},'bad'),
      ()=>fs.writeFileSync(${JSON.stringify(path.join(allowed,'alias','bad'))},'bad'),
      ()=>fs.truncateSync(${JSON.stringify(path.join(denied,'keep'))},0),
      ()=>fs.renameSync(${JSON.stringify(path.join(allowed,'ok'))},${JSON.stringify(path.join(denied,'moved'))})];
    for(const attempt of attempts){try{attempt();process.exit(71)}catch(e){if(!['EACCES','EXDEV'].includes(e.code))throw e;}}
    const grandchild=cp.spawnSync('/bin/sh',['-c',${JSON.stringify(`echo forbidden > '${denied}/shell'; echo permitted > '${allowed}/shell'`)}]);
    if(grandchild.status!==0)process.exit(72); console.log('enforced');`;
  const result = await run(boundary, code, allowed);
  assert.equal(result.code, 0, result.error); assert.match(result.output, /enforced/);
  assert.equal(fs.readFileSync(path.join(denied,'keep'),'utf8'),'ORIGINAL');
  assert.equal(fs.existsSync(path.join(denied,'bad')),false); assert.equal(fs.existsSync(path.join(denied,'shell')),false);
  assert.equal(fs.readFileSync(path.join(allowed,'shell'),'utf8'),'permitted\n');
});
test('kernel read scope denies bytes outside roots to native child and its child', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-v2-read-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const allowed=path.join(root,'allowed'), denied=path.join(root,'denied'); fs.mkdirSync(allowed);fs.mkdirSync(denied);
  const secret=path.join(denied,'input');fs.writeFileSync(secret,'synthetic');
  const boundary={readRoots:['/usr','/etc/ssl',fs.realpathSync(process.execPath),allowed],writeRoots:[allowed],revision:1,source:'owned-fixture'};
  const result=await run(boundary,`const fs=require('fs'),cp=require('child_process');try{fs.readFileSync(${JSON.stringify(secret)});process.exit(71)}catch(e){if(e.code!=='EACCES')throw e;}const r=cp.spawnSync('/usr/bin/cat',[${JSON.stringify(secret)}]);if(r.status===0)process.exit(72);console.log('read-denied');`,allowed);
  assert.equal(result.code,0,result.error); assert.match(result.output,/read-denied/);
});
test('missing parent scope and alias roots refuse rather than inventing authority', () => {
  assert.throws(()=>scope.run(null,()=>{}),{code:'FLEET_FOLDER_SCOPE_UNAVAILABLE'});
  assert.throws(()=>scope.normalize({readRoots:['relative'],writeRoots:[],revision:1,source:'fixture'}),{code:'FLEET_FOLDER_SCOPE_INVALID'});
});
test('retained native cleanup quiesces a detached active shell descendant before returning', {skip:process.platform!=='linux'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-v2-quiesce-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const target=path.join(root,'ticks');
 const {createCodexProcessTransport}=require('../src/lib/agent-engine/codex-process');
 const inner=`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(target)},'x'),10);`;
 const outer=`const cp=require('child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(inner)}],{detached:true,stdio:'ignore'}).unref();console.log('owned-started');setInterval(()=>{},1000);`;
 const transport=scope.run({readRoots:['/'],writeRoots:[root,'/dev/null'],revision:1,source:'owned-test'},()=>createCodexProcessTransport({command:process.execPath,args:['-e',outer],cwd:root,env:{PATH:'/usr/bin:/bin'},containProcessTree:true}));
 t.after(()=>transport.closeForStartupFailure());
 await new Promise((resolve,reject)=>{
   let stderr=''; transport.onStderr?.(text=>{stderr+=text});
   const deadline=setTimeout(()=>{clearInterval(poll);reject(Error('Owned descendant did not write: '+stderr))},3000);
   const poll=setInterval(()=>{if(fs.existsSync(target)){clearTimeout(deadline);clearInterval(poll);resolve();}},10);
 });
 const result=await transport.closeForStartupFailure();assert.equal(result.activeProcesses,0);
 const bytes=fs.readFileSync(target);await new Promise(resolve=>setTimeout(resolve,100));
 assert.deepEqual(fs.readFileSync(target),bytes);
});
