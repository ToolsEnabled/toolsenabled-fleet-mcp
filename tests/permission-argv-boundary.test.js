'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRegistry } = require('../src/lib/agents/registry');
const { levelFromArgv, workerSettings, leadPermissionContext } = require('../src/lib/agents/permission-level');
const registry = loadRegistry();

test('permission-looking positional text cannot raise any bundled provider level', () => {
  for (const agent of registry.agents) {
    const flags = agent.permissions.lead.flatMap(rule =>
      Object.entries(rule.when).flatMap(([key, value]) => value === true ? [key] : [key, value]));
    assert.equal(levelFromArgv(agent, ['--', ...flags]), 2, agent.id);
    for (const rule of agent.permissions.lead) {
      const args = Object.entries(rule.when).flatMap(([key, value]) => value === true ? [key] : [key, value]);
      const before = levelFromArgv(agent, args);
      assert.equal(levelFromArgv(agent, [...args, '--', ...flags]), before, agent.id);
    }
  }
});

test('read-only Codex parent stays read-only through worker settings and diagnostics', () => {
  const descriptor = registry.get('codex');
  const argv = ['codex', '--sandbox', 'read-only', '--', '--yolo'];
  const observed = leadPermissionContext({ registry, env: {}, startPid: 42, read: () => argv });
  assert.equal(observed.detected, 1);
  assert.equal(observed.level, 1);
  assert.deepEqual(workerSettings(descriptor, observed.level), descriptor.permissions.worker[1]);
  assert.equal(workerSettings(descriptor, observed.level).sandbox, 'read-only');
});

test('Gemini yargs boolean false and negation cannot enable yolo', () => {
  const descriptor = registry.get('gemini');
  for (const args of [
    ['--yolo', 'false'], ['--yolo=false'], ['--yolo', '--no-yolo'], ['-y', 'false'],
  ]) assert.equal(levelFromArgv(descriptor, [...args, '--approval-mode', 'plan']), 1, JSON.stringify(args));
  for (const args of [['--yolo'], ['-y'], ['--yolo=true'], ['--yolo', 'true'], ['--no-yolo', '--yolo']])
    assert.equal(levelFromArgv(descriptor, args), 4, JSON.stringify(args));
});

test('Codex attached short values and explicit read-only config narrow workers', () => {
  const descriptor = registry.get('codex');
  for (const args of [
    ['-sread-only'], ['-c', 'sandbox_mode="read-only"'], ["-csandbox_mode='read-only'"],
    ['--config=sandbox_mode="read-only"'], ['--full-auto', '-c', 'sandbox_mode = "read-only"'],
    ['-c', 'sandbox_mode=read-only'], ['--full-auto', '--config=sandbox_mode=read-only'],
    ['-a', 'never', '-c', 'sandbox_mode="read-only" # readonly'],
    ['-a', 'never', '-c', 'sandbox_mode="read\\u002donly"'],
    ['-a', 'never', '-c', 'sandbox_mode="""read-only"""'],
    ['-a', 'never', '-c', 'sandbox_mode="""\nread-only"""'],
    ['-a', 'never', '-c', "sandbox_mode='''\nread-only'''"],
  ]) assert.equal(levelFromArgv(descriptor, args), 1, JSON.stringify(args));
  assert.equal(levelFromArgv(descriptor, ['--', '-sread-only']), 2);
  assert.equal(levelFromArgv(descriptor, ['--', '-c', 'sandbox_mode="read-only"']), 2);
  assert.equal(levelFromArgv(descriptor, ['-c', 'sandbox_mode="danger-full-access"']), 2);
});

test('argv syntax is validated descriptor data and survives renaming a provider', () => {
  const { validateDescriptor } = require('../src/lib/agents/registry');
  const source = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '../config/agents/codex.json')));
  source.id = 'fixture-cli'; source.name = 'Fixture CLI'; source.command = 'fixture-cli';
  const renamed = validateDescriptor(source, 'fixture');
  assert.equal(levelFromArgv(renamed, ['-sread-only']), 1);
  assert.equal(levelFromArgv(renamed, ['--full-auto', '-c', 'sandbox_mode="read-only"']), 1);
  for (const syntax of [
    { booleanNegation: 'true' }, { attachedValueOptions: ['--long'] },
    { attachedValueOptions: false }, { readOnlyConfig: { options: ['--config'], key: 'bad key', value: 'read-only' } },
    { futureBehavior: true },
  ]) {
    assert.throws(() => validateDescriptor({ ...source, permissions: { ...source.permissions, argv: syntax } }, 'fixture'));
  }
});
