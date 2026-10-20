'use strict';
require('./lib/isolated-environment').activate('fleet-issues');
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuredStartupTimeout, startCodexSession, resumeCodexSession } = require('../src/lib/agent-engine/codex-process');
const { toolError } = require('../src/mcp-server');

test('plugin instructions give a setup command usable by Codex', () => {
  const note = require('../src/lib/host-descriptions').briefToolSummary({
    tier: 'standard', setupKind: 'plugin', allowedNames: ['memory.get', 'host.read_file'] });
  assert.match(note.text, /node bin\/toolsenabled-host.js setup --plugin/);
  assert.match(note.text, /CODEX.md/);
  assert.doesNotMatch(note.text, /\/tefleet|this Claude Code plugin/);
});

test('startup timeout uses the selected environment and refuses invalid settings before launch', async () => {
  assert.equal(configuredStartupTimeout({}), 60000);
  assert.equal(configuredStartupTimeout({ TOOLSENABLED_CODEX_START_TIMEOUT_MS: '180000' }), 180000);
  for (const value of ['-1', '1000.5', '0', '600001', 'Infinity', 'secret-value']) {
    const options = { cwd: process.cwd(), env: { TOOLSENABLED_CODEX_START_TIMEOUT_MS: value } };
    await assert.rejects(startCodexSession(options), { code: 'CODEX_START_TIMEOUT_INVALID' });
    await assert.rejects(resumeCodexSession({ ...options, threadId: 'not-launched' }), { code: 'CODEX_START_TIMEOUT_INVALID' });
  }
});

test('startup timeouts have safe actionable text and code in both MCP result forms', () => {
  const result = toolError(Object.assign(new Error('private provider diagnostic SECRET_SENTINEL'), { code: 'CODEX_START_TIMEOUT' }));
  assert.match(JSON.stringify(result.content), /CODEX_START_TIMEOUT/);
  assert.match(JSON.stringify(result.content), /Linux-native CODEX_HOME/);
  assert.match(JSON.stringify(result.structuredContent), /CODEX_START_TIMEOUT/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_SENTINEL|private provider diagnostic/);
});

test('an invisible Windows lead still falls back and cannot be raised by an environment cap', () => {
  const levels = require('../src/lib/agents/permission-level');
  const registry = require('../src/lib/agents/registry').activeRegistry();
  for (const cap of ['3', '4']) {
    const context = levels.leadPermissionContext({ registry, startPid: 42,
      read: () => ['/init'], parent: () => 1, env: { TOOLSENABLED_LEVEL_CAP: cap } });
    assert.equal(context.level, 2);
    assert.equal(context.verifiedParent, false);
    assert.equal(context.fallback, true);
  }
});
