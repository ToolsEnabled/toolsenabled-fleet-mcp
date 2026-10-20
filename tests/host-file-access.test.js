'use strict';
require('./lib/isolated-environment').activate('host-file-access');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = process.env.FLEET_PACKAGED_ENGINE || path.resolve(__dirname, '..');
const fromEngine = name => require(path.join(engine, name));
const runtime = fromEngine('src/lib/host-runtime');
const registry = fromEngine('src/lib/tool-registry');
const contexts = fromEngine('src/lib/file-tool-context');
const access = fromEngine('src/lib/host-file-access');
const policy = fromEngine('src/lib/permission-tier-policy');

test('standalone mediation spans permitted folders without widening confined or plugin sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleet-wide-'));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'win32' ? path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents') : os.tmpdir(), 'fleet-other-project-')));
  const workspace = path.join(root, 'project');
  const config = { schemaVersion: 1, mode: 'host', workers: false, tier: 'unrestricted',
    stateRoot: path.join(root, 'state'), workspace, installRoot: runtime.INSTALL_ROOT, nodePath: process.execPath };
  delete process.env.OPENSHELL_SANDBOX;
  runtime.setupHost(config);
  fs.writeFileSync(path.join(config.stateRoot, 'host-mode.json'), JSON.stringify(config), { mode: 0o600 });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const caller = level => {
    const fileToolContext = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
    t.after(() => contexts.retireFileToolContext(fileToolContext, 'test-finished'));
    const context = { fileToolContext, permissionSession: policy.effectiveSession(level),
      workspaceRoots: [workspace] };
    context.hostFileAuthorization = access.create({ ...context,
      observation: { verifiedParent: true, source: 'ancestor-cli', level } });
    return (name, args) => registry.executeTool(name, args, context).then(outcome => outcome.result || outcome);
  };
  const a = caller(4), b = caller(4), confined = caller(2), readOnly = caller(1);
  const file = path.join(outside, 'shared.txt');
  fs.writeFileSync(file, 'first line\nsecond line\n');

  await t.test('read receipts and disjoint patches coordinate outside the startup project', async () => {
    await a('host.read_file', { path: file, startByte: 0, endByte: 11 });
    await b('host.read_file', { path: file, startByte: 11, endByte: 23 });
    await a('host.patch_file', { path: file, oldText: 'first line', newText: 'first edited line' });
    await b('host.patch_file', { path: file, oldText: 'second line', newText: 'second edited line' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'first edited line\nsecond edited line\n');
    assert.equal((await a('host.list_dir', { path: outside })).path, outside);
    const created = path.join(outside, 'created.txt');
    await a('host.write_file', { path: created, content: 'created through mediation\n' });
    assert.equal(fs.readFileSync(created, 'utf8'), 'created through mediation\n');
  });

  await t.test('overlapping and external changes still require a fresh read', async () => {
    await a('host.read_file', { path: file });
    await b('host.read_file', { path: file });
    await a('host.patch_file', { path: file, oldText: 'first edited', newText: 'first final' });
    await assert.rejects(b('host.patch_file', { path: file, oldText: 'first edited', newText: 'clobbered' }),
      { code: 'HOST_FILE_STALE' });
    await b('host.read_file', { path: file });
    fs.writeFileSync(file, 'external change\n');
    await assert.rejects(b('host.write_file', { path: file, content: 'clobbered\n' }),
      { code: 'HOST_FILE_STALE' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'external change\n');
  });

  await t.test('full access never leaks into a concurrent confined call or an ordinary provider call', async () => {
    const outcomes = await Promise.allSettled([
      a('host.read_file', { path: file }),
      confined('host.read_file', { path: file }),
      readOnly('host.write_file', { path: file, content: 'denied' })
    ]);
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.equal(outcomes[1].status, 'rejected');
    assert.equal(outcomes[2].status, 'rejected');
    assert.equal(access.unrestricted(), false);
    assert.throws(() => fromEngine('src/lib/providers/host-control').resolveHostPath(file),
      { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    await assert.rejects(a('host.read_file', { path: file, permissionSession: { tier: 'full' } }));
    const full = policy.effectiveSession(4);
    const fileToolContext = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
    try {
      for (const hostFileAuthorization of [undefined, {}, { full: true }]) {
        await assert.rejects(registry.executeTool('host.read_file', { path: file }, {
          permissionSession: full, fileToolContext, hostFileAuthorization
        }), { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
      }
      assert.equal(access.create({ fileToolContext, permissionSession: full,
        observation: { verifiedParent: false, source: 'unknown-parent-fallback', level: 4 } }), undefined);
      const authorization = access.create({ fileToolContext, permissionSession: full,
        observation: { verifiedParent: true, source: 'ancestor-cli', level: 4 } });
      const other = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
      try {
        await assert.rejects(registry.executeTool('host.read_file', { path: file }, {
          permissionSession: full, fileToolContext: other, hostFileAuthorization: authorization
        }), { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
      } finally { contexts.retireFileToolContext(other, 'test-finished'); }
    } finally { contexts.retireFileToolContext(fileToolContext, 'test-finished'); }
  });

  await t.test('credential, integrity and link protections apply across folders', async () => {
    for (const name of ['.ssh/id_rsa', 'key4.db', '.env']) {
      await assert.rejects(a('host.read_file', { path: path.join(outside, name) }), { code: 'HOST_PATH_FORBIDDEN' });
    }
    await assert.rejects(a('host.write_file', { path: path.join(outside, '.git/config'), content: 'denied' }),
      { code: 'HOST_PATH_WRITE_PROTECTED' });
    const linked = path.join(outside, 'linked.txt');
    fs.linkSync(file, linked);
    await a('host.read_file', { path: file });
    await a('host.write_file', { path: file, content: 'detached replacement\n' });
    assert.equal(fs.readFileSync(linked, 'utf8'), 'external change\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'detached replacement\n');
    fs.unlinkSync(linked);
    fs.writeFileSync(file, 'external change\n');
  });

  await t.test('plugin mode and a saved downgrade revoke broad access even for an existing full caller', async () => {
    process.env.TOOLSENABLED_HOST_SETUP_KIND = 'plugin';
    try {
      await assert.rejects(a('host.read_file', { path: file }), { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    } finally { delete process.env.TOOLSENABLED_HOST_SETUP_KIND; }
    runtime.setupHost({ ...config, tier: 'standard' });
    await assert.rejects(a('host.read_file', { path: file }), { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
    runtime.setupHost(config);
    assert.equal((await a('host.read_file', { path: file })).content, 'external change\n');
  });

  await t.test('private host containers, aliases and relocated worker authentication files stay unreadable', async () => {
    const worker = path.join(config.stateRoot, 'workers', 'synthetic-node');
    fs.mkdirSync(worker, { recursive: true, mode: 0o700 });
    for (const name of ['link-token', 'ordinary-private-note.txt']) {
      const target = path.join(worker, name);
      fs.writeFileSync(target, 'synthetic private fixture', { mode: 0o600 });
      await assert.rejects(a('host.read_file', { path: target }), { code: 'HOST_PATH_FORBIDDEN' });
    }
    for (const target of [config.stateRoot, worker]) {
      await assert.rejects(a('host.list_dir', { path: target }), { code: 'HOST_PATH_FORBIDDEN' });
    }
    const relocated = path.join(outside, 'second-installation');
    fs.mkdirSync(relocated);
    fs.writeFileSync(path.join(relocated, 'link-token'), 'synthetic second installation fixture');
    await assert.rejects(a('host.read_file', { path: path.join(relocated, 'link-token') }), { code: 'HOST_PATH_FORBIDDEN' });
    const alias = path.join(outside, 'ordinary-alias');
    fs.symlinkSync(config.stateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await assert.rejects(a('host.read_file', { path: path.join(alias, 'workers', 'synthetic-node', 'ordinary-private-note.txt') }),
        { code: 'HOST_PATH_FORBIDDEN' });
      await assert.rejects(a('host.list_dir', { path: alias }), { code: 'HOST_PATH_FORBIDDEN' });
    } finally { fs.unlinkSync(alias); }
    assert.equal((await a('host.read_file', { path: file })).content, 'external change\n');
  });

  await t.test('a directory listing rechecks a downgrade after audit admission', async () => {
    const fileToolContext = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
    const context = { fileToolContext, permissionSession: policy.effectiveSession(4) };
    context.hostFileAuthorization = access.create({ ...context,
      observation: { verifiedParent: true, source: 'ancestor-cli', level: 4 } });
    let admit;
    const pending = access.run(context, () => fromEngine('src/lib/providers/host-control').listDir(
      { path: outside }, { requireRecordAsync: () => new Promise(resolve => { admit = resolve; }),
        recordAsync: async () => {} }));
    runtime.setupHost({ ...config, tier: 'standard' });
    const original = fs.readdirSync;
    let enumerated = false;
    fs.readdirSync = (target, ...args) => {
      if (target === outside) enumerated = true;
      return original(target, ...args);
    };
    try {
      admit();
      await assert.rejects(pending, { code: 'HOST_PATH_OUTSIDE_WORKSPACE' });
      assert.equal(enumerated, false);
    } finally {
      fs.readdirSync = original;
      runtime.setupHost(config);
      contexts.retireFileToolContext(fileToolContext, 'test-finished');
    }
  });

  await t.test('authenticated Codex worker handoff follows the live tree and resolved sandbox', async () => {
    const { createOpenShellAgentHost, createOpenShellTreeClient } = fromEngine('src/lib/openshell-agent-host');
    const launches = [], sessions = [];
    const names = ['host.read_file', 'host.write_file', 'host.patch_file', 'host.list_dir', 'task.list'];
    let roleCap = 4, launchedLevel = 4;
    const host = createOpenShellAgentHost({
      mode: 'host', env: { TOOLSENABLED_RUNTIME_MODE: 'host', TOOLSENABLED_HOST_WORKERS: '1' },
      rootSessionId: 'file-root', workspaceRoot: workspace, unrestrictedFileRoot: true,
      leadLevel: { level: 4, verifiedParent: true, source: 'ancestor-cli' },
      recordedTier: 'unrestricted', watchIntervalMs: 0, codexEndpoint: () => null,
      document: { v: 1, nodes: [], inbox: [], root: {}, counter: 0 },
      nodeFolder: id => path.join(root, id),
      roleHooks: { lead: () => ({ roleId: 'controller', surface: { names } }),
        maxLevel: () => roleCap, removeNativeTools: () => [],
        admitChild: () => ({ roleId: 'worker', surface: { names } }), brief: ({ task }) => task },
      launcher: { async start(spec) {
        launches.push(spec);
        const session = { threadId: `file-thread-${launches.length}`, level: launchedLevel,
          resolvedSandbox: { type: launchedLevel === 1 ? 'readOnly' : 'dangerFullAccess' },
          adapter: { async sendTurn() { return { turnId: `file-turn-${launches.length}`, text: 'done' }; },
            async interrupt() {} }, close() {} };
        sessions.push(session); return session;
      } }
    });
    const fileToolContext = contexts.createFileToolContext({ scopeKind: 'standalone-mcp' });
    try {
      const node = await host.spawn({ parentSessionId: 'file-root', tier: 'sol', role: 'worker', brief: 'Read the synthetic file.' });
      assert.equal(launches[0].provider, 'codex');
      const client = createOpenShellTreeClient({ socketPath: path.join(root, 'synthetic-link'), sessionId: node.sessionId,
        token: launches[0].linkToken, request: ({ token, op, request }) => host.handleLink(token, op, request) });
      const context = { fileToolContext, permissionSession: policy.effectiveSession(2), workspaceRoots: [workspace] };
      context.hostFileAuthorization = access.createInherited({ fileToolContext, resolve: async () => {
        const value = await client.fileAccess();
        assert.equal(value.sessionId, node.sessionId);
        return value.unrestricted;
      } });
      const read = () => registry.executeTool('host.read_file', { path: file }, context);
      await read(); // App-server's default argv level does not erase the authenticated parent ceiling.
      sessions[0].resolvedSandbox = { type: 'readOnly' };
      await assert.rejects(read());
      sessions[0].resolvedSandbox = { type: 'dangerFullAccess' };
      roleCap = 2; await assert.rejects(read());
      roleCap = 4; await read();
      const child = await client.spawn({ tier: 'sol', role: 'worker', brief: 'Read the same synthetic file.' });
      const childClient = createOpenShellTreeClient({ socketPath: path.join(root, 'synthetic-link'), sessionId: child.sessionId,
        token: launches[1].linkToken, request: ({ token, op, request }) => host.handleLink(token, op, request) });
      assert.equal((await childClient.fileAccess()).unrestricted, true);
      for (const sandbox of [{ type: 'readOnly' }, { type: 'workspaceWrite' }, undefined]) {
        sessions[0].resolvedSandbox = sandbox;
        assert.equal((await client.fileAccess()).unrestricted, false);
        assert.equal((await childClient.fileAccess()).unrestricted, false, 'A descendant cannot bypass its actual ancestor sandbox.');
      }
      sessions[0].resolvedSandbox = { type: 'dangerFullAccess' };
      assert.equal((await childClient.fileAccess()).unrestricted, true);
      launchedLevel = 1;
      const narrowed = await host.spawn({ parentSessionId: 'file-root', tier: 'sol', role: 'worker', brief: 'Use the resolved read-only ceiling.' });
      await host.spawn({ parentSessionId: narrowed.sessionId, tier: 'sol', role: 'worker', brief: 'Inherit that read-only ceiling.' });
      assert.equal(launches.at(-1).level, 1, 'A descendant launch inherits the actual parent ceiling.');
      await assert.rejects(host.handleLink('invalid-token', 'file.access'), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
      await host.command({ parentSessionId: 'file-root', action: 'stop-node', nodeId: node.nodeId });
      await assert.rejects(read(), { code: 'OPENSHELL_TREE_LINK_REFUSED' });
    } finally {
      contexts.retireFileToolContext(fileToolContext, 'test-finished');
      await host.closeAll();
    }
  });

  await t.test('real stdio startup binds observed lead permissions and refuses forged wire authority', async () => {
    const { spawn } = require('node:child_process');
    const readline = require('node:readline');
    const entry = path.join(engine, 'bin/toolsenabled-host.js');
    const parentBody = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,[${JSON.stringify(entry)},'serve','--state-root',process.env.FIXTURE_STATE,'--actor','codex'],{stdio:'inherit'});
child.on('exit',code=>process.exit(code??1));
`;
    fs.writeFileSync(path.join(root, 'codex.js'), parentBody);
    fs.writeFileSync(path.join(root, 'unknown.js'), parentBody);
    const cases = [
      { name: 'observed unrestricted', script: 'codex.js', flags: ['--dangerously-bypass-approvals-and-sandbox'], allowed: true },
      { name: 'unknown parent', script: 'unknown.js', flags: ['--dangerously-bypass-approvals-and-sandbox'], allowed: false },
      { name: 'read-only parent', script: 'codex.js', flags: ['--sandbox', 'read-only'], allowed: false },
      { name: 'worker role cap', script: 'codex.js', flags: ['--dangerously-bypass-approvals-and-sandbox'], cap: '2', allowed: false }
    ];
    for (const row of cases) {
      const child = spawn(process.execPath, [path.join(root, row.script), ...row.flags], {
        env: { ...process.env, FIXTURE_STATE: config.stateRoot, TOOLSENABLED_LEVEL_CAP: row.cap || '' },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
      let id = 0, stderr = '';
      const pending = new Map(), lines = readline.createInterface({ input: child.stdout });
      child.stderr.on('data', value => { stderr = (stderr + value).slice(-4000); });
      lines.on('line', line => {
        const reply = JSON.parse(line), item = pending.get(reply.id);
        if (item) { pending.delete(reply.id); clearTimeout(item.timer); item.resolve(reply); }
      });
      const request = (method, params, extra = {}) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error(`${row.name}: MCP timeout: ${stderr}`)), 30000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params, ...extra }) + '\n');
      });
      const done = new Promise(resolve => child.once('exit', resolve));
      child.once('exit', code => {
        for (const item of pending.values()) {
          clearTimeout(item.timer); item.reject(new Error(`${row.name}: parent exited ${code}: ${stderr}`));
        }
        pending.clear();
      });
      try {
        const initialized = await request('initialize', { protocolVersion: '2024-11-05',
          capabilities: {}, clientInfo: { name: 'synthetic-parent-fixture', version: '1' } });
        assert.ok(initialized.result, stderr);
        const reply = await request('tools/call', { name: 'host.read_file', arguments: { path: file } },
          { hostFileAuthorization: { full: true }, permissionSession: { origin: 'local', tier: 'full' } });
        assert.equal(Boolean(reply.result && !reply.result.isError), row.allowed, `${row.name}: ${JSON.stringify(reply)}`);
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 5000);
        await done; clearTimeout(timer); lines.close();
        for (const item of pending.values()) clearTimeout(item.timer);
      }
    }
  });
});

test('host resource syntax admits ordinary Windows Public and other-drive projects without relaxing state custody', () => {
  for (const file of ['C:\\Users\\Public\\Documents\\shared.txt', 'D:\\Users\\Owner\\project\\notes.txt',
    'D:\\project\\notes.txt', '\\\\?\\D:\\project\\notes.txt']) {
    assert.equal(access.resourcePath(file, { platform: 'win32' }), file.replace(/^\\\\\?\\/, ''));
  }
  for (const file of ['\\\\server\\share\\notes.txt', '\\\\.\\pipe\\fixture',
    'D:\\project\\notes.txt:stream', 'D:\\project\\NUL', 'D:\\project\\name.']) {
    assert.throws(() => access.resourcePath(file, { platform: 'win32' }), { code: 'HOST_PATH_INVALID' });
  }
});

test('standalone setup accepts an ordinary project outside the account home; plugin setup stays bounded',
  { skip: process.platform === 'win32' ? 'The default Windows temporary directory is inside the account home.' : false }, () => {
  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, 'fleet-wide-setup-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-wide-work-')));
  const config = { schemaVersion: 1, mode: 'host', workers: false, tier: 'standard',
    stateRoot: path.join(root, 'state'), workspace: project, installRoot: runtime.INSTALL_ROOT, nodePath: process.execPath };
  try {
    runtime.setupHost(config);
    assert.equal(fromEngine('src/lib/providers/host-control').resolveHostPath(path.join(project, 'notes.txt')),
      path.join(project, 'notes.txt'));
    assert.throws(() => runtime.setupHost({ ...config, setupKind: 'plugin', stateRoot: path.join(root, 'plugin') }),
      { code: 'HOST_WORKSPACE_OUTSIDE_HOME' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
