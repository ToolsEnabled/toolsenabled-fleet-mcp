'use strict';
require('./lib/isolated-environment').activate('windows-worker-lifecycle');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = process.env.FLEET_PACKAGED_ENGINE || path.resolve(__dirname, '..');
const fromEngine = name => require(path.join(engine, name));
const os = require('node:os');
const link = fromEngine('src/lib/openshell-tree-link');

test('native Windows contained worker inherits, refuses approval, authenticates IPC and resumes with a new token', {
  skip: process.platform !== 'win32', timeout: 180000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleet-worker-native-'));
  const state = path.join(root, 'state');
  fromEngine('src/lib/windows-state-security').check('create', state);
  const logFile = path.join(root, 'wire.jsonl');
  const fixture = path.join(root, 'peer.cjs');
  // A local protocol peer, never an installed CLI or model service. The real
  // launcher, adapter, Job Object, tree state and IPC run unchanged.
  fs.writeFileSync(fixture, `
const fs=require('node:fs'), readline=require('node:readline');
const log=value=>fs.appendFileSync(process.env.MATRIX_LOG,JSON.stringify({pid:process.pid,...value})+'\\n');
if(process.argv.includes('--version')){console.log('codex-cli 0.160.0');process.exit(0);}
log({started:true,args:process.argv.slice(2)});
let threadId='native-fixture-thread',turn=0;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const result=(id,value)=>send({id,result:value});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const packet=JSON.parse(line);log({packet});
 const {id,method,params}=packet;
 if(method==='initialize')result(id,{userAgent:'native-local-fixture'});
 else if(method==='initialized')return;
 else if(method==='config/read')result(id,{config:{developer_instructions:''}});
 else if(method==='thread/start'||method==='thread/resume'){
  threadId=params.threadId||threadId;
  result(id,{thread:{id:threadId,cwd:process.cwd(),turns:[]},model:'fixture',reasoningEffort:null,sandbox:{type:'readOnly'}});
 }else if(method==='thread/turns/list')result(id,{data:[],nextCursor:null});
 else if(method==='turn/start'){
  turn++;result(id,{turn:{id:'turn-'+turn}});
  send({id:'approval-'+turn,method:'item/fileChange/requestApproval',params:{threadId,turnId:'turn-'+turn,itemId:'file',startedAtMs:1}});
 }else if(typeof id==='string'&&id.startsWith('approval-')){
  log({approvalResponse:packet.result});
  send({method:'turn/completed',params:{threadId,turn:{id:'turn-'+turn,status:'completed',items:[]}}});
 }else if(method==='turn/interrupt')result(id,{});
 else throw Error('Unexpected fixture packet '+method);
});
`);
  const command = path.join(root, 'peer.cmd');
  fs.writeFileSync(command, `@"${process.execPath}" "${fixture}" %*\r\n`);
  const env = {
    SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    PATH: path.dirname(process.execPath), HOME: root, USERPROFILE: root,
    LOCALAPPDATA: path.join(root, 'local'), CODEX_HOME: path.join(root, 'codex'),
    MATRIX_LOG: logFile, TOOLSENABLED_STATE_ROOT: process.env.TOOLSENABLED_STATE_ROOT,
    TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1',
    TOOLSENABLED_TOOL_ALLOWLIST: 'agent.spawn,task.list', TOOLSENABLED_LEVEL_CAP: '1',
  };
  const config = { mode: 'host', workers: true, stateRoot: state, workspace: root };
  const socketPath = link.socketPathFor(path.join(state, 'tree.sock'));
  const sessions = [];
  const native = fromEngine('src/lib/agent-engine/codex-process');
  const launch = async (options, resume) => {
    assert.equal(options.containProcessTree, true);
    assert.equal(options.threadOptions.sandbox, 'read-only');
    assert.equal(options.threadOptions.approvalPolicy, 'never');
    const session = await native[resume ? 'resumeCodexSession' : 'startCodexSession']({ ...options, command });
    sessions.push(session);
    return session;
  };
  const launcher = fromEngine('src/lib/host-worker-session').createHostWorkerLauncher({
    env, config, workspaceRoot: root, socketPath, agentApiMode: 'Enabled',
    startCodex: options => launch(options, false), resumeCodex: options => launch(options, true),
  });
  const document = { nodes: [], inbox: [] };
  const host = fromEngine('src/lib/openshell-agent-host').createOpenShellAgentHost({
    mode: 'host', env, launcher, document, workspaceRoot: root, rootSessionId: 'native-root',
    root: { actor: 'codex' }, leadLevel: 1, watchIntervalMs: 0, codexEndpoint: () => null,
    roleHooks: {
      lead: () => ({ roleId: null, surface: { names: ['agent.spawn', 'task.list'] } }),
      admitChild: () => ({ roleId: null, surface: { names: ['agent.spawn', 'task.list'] } }),
      maxLevel: () => 4, brief: ({ task }) => task,
    },
    baseAllowlist: ['agent.spawn', 'task.list'], slotBounds: { maxChildren: 2, maxDepth: 2 },
    nodeFolder: id => path.join(state, 'nodes', id),
  });
  const server = link.createTreeLinkServer({ socketPath, handle: host.handleLink });
  let completed = false;
  t.after(async () => {
    await host.closeAll(); await server.close();
    if (completed) {
      await until(() => rows().filter(row => row.started).every(row => {
        try { process.kill(row.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      }), 'all contained peers ended');
      // Keep the event loop available while the native wrapper closes its
      // retained handles; synchronous retries can hold its own cleanup open.
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  });
  await server.listen();
  const rows = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  async function until(predicate, label) {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const registry = fromEngine('src/lib/agents/registry').loadRegistry();
  const tier = registry.get('codex').models.defaults.standard;
  const receipt = await host.spawn({ parentSessionId: 'native-root', tier, brief: 'Complete the local fixture turn.' });
  const node = document.nodes.find(item => item.nodeId === receipt.nodeId);
  await until(() => node.lastTurn, 'first worker turn completed');
  assert.equal(node.level, 1);
  assert.equal(node.lastTurn.status, 'completed');
  assert.match(node.lastTurn.text, /no permission grants|no human rejected|no answer or new permissions/i);
  assert.deepEqual(rows().filter(row => row.approvalResponse).map(row => row.approvalResponse), [{ decision: 'decline' }]);
  const tokenFile = path.join(state, 'nodes', node.nodeId, 'link-token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const ask = (value, op = 'whoami', request = {}) => link.treeLinkRequest({ socketPath, token: value, op, request, timeoutMs: 5000 });
  assert.equal((await ask(token)).nodeId, node.nodeId);
  await assert.rejects(ask('unrelated-token'), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
  const firstPid = rows().find(row => row.started).pid;
  await host.command({ parentSessionId: 'native-root', action: 'stop-node', nodeId: node.nodeId });
  await until(() => { try { process.kill(firstPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }, 'contained worker ended');
  await assert.rejects(ask(token), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
  await host.command({ parentSessionId: 'native-root', action: 'resume-node', nodeId: node.nodeId });
  const replacement = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.notEqual(replacement, token);
  assert.equal((await ask(replacement)).nodeId, node.nodeId);
  await assert.rejects(ask(token), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
  assert.equal(node.level, 1);
  assert.equal(sessions.length, 2);
  assert.ok(rows().some(row => row.packet?.method === 'thread/resume'));
  completed = true;
});
