#!/usr/bin/env node
'use strict';

process.umask(0o077);
const path = require('node:path');
const setup = require('../src/lib/fleet-v2-setup');

function parse(argv) {
  const result = { command: argv[0] || 'help', stateRoot: setup.defaultStateRoot(), readRoots: [], writeRoots: [], readAll: false, workers: true };
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--coordination-only') { result.workers = false; continue; }
    if (option === '--read-all') { result.readAll = true; continue; }
    if (option === '--json') { result.json = true; continue; }
    const names = { '--state-root': 'stateRoot', '--workspace': 'workspace', '--read-root': 'readRoots', '--write-root': 'writeRoots', '--actor': 'actor', '--tree-key': 'treeKey', '--revision': 'revision' };
    const name = names[option];
    if (!name || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${option}`);
    if (!['readRoots', 'writeRoots'].includes(name) && seen.has(name)) throw new Error(`Supply ${option} once.`);
    seen.add(name);
    const value = argv[++i];
    if (Array.isArray(result[name])) result[name].push(value); else result[name] = name === 'revision' ? Number(value) : value;
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write('fleetV2: setup | serve | status | scope\n'
      + 'setup --workspace ABS --state-root ABS (--read-root ABS ... | --read-all) [--write-root ABS ...] [--coordination-only]\n'
      + 'serve --state-root ABS --actor PROVIDER [--tree-key KEY]\n'
      + 'status --state-root ABS\n'
      + 'scope --state-root ABS --revision CURRENT (--read-root ABS ... | --read-all) [--write-root ABS ...]\n'
      + 'Supply the lead folder policy explicitly. Workers use bypass within that same policy. A task or Ask answer cannot grant a new folder.\n'); return;
  }
  if (argv.length === 1 && argv[0] === '--version') { process.stdout.write(`fleetV2 ${require('../fleetV2.json').version}\n`); return; }
  const options = parse(argv);
  if (options.command === 'scope') {
    if (options.actor || options.treeKey || options.workspace || !options.workers) throw new Error('Scope edits take only state root, revision and complete read/write roots.');
    process.stdout.write(JSON.stringify(setup.updateScope(options)) + '\n'); return;
  }
  if (options.revision !== undefined) throw new Error('Revision applies only to a scope update.');
  if (options.command === 'setup') {
    if (options.actor || options.treeKey) throw new Error('Actor and tree key apply only to serve.');
    process.stdout.write(JSON.stringify(setup.setup(options)) + '\n'); return;
  }
  if (!['serve', 'status'].includes(options.command)) throw new Error('Use fleetV2 setup, serve or status.');
  if (options.workspace || options.readRoots.length || options.writeRoots.length || options.readAll || !options.workers)
    throw new Error('Folder policy is established by setup, never by a serve invocation.');
  const runtime = require('../src/lib/host-runtime');
  const config = runtime.readHostConfig(options.stateRoot);
  if (config.profile !== 'fleetV2' || config.setupKind === 'plugin' || !config.fleetV2Scope)
    throw new Error('This state is not a standalone fleetV2 installation.');
  if (options.command === 'status') {
    process.stdout.write(JSON.stringify({ name: 'fleetV2', version: require('../fleetV2.json').version,
      workers: config.workers, workspace: config.workspace, folderScope: config.fleetV2Scope,
      coordination: 'tasks-rules-asks', entry: path.join(runtime.INSTALL_ROOT, 'bin', 'fleetV2.js') }) + '\n'); return;
  }
  if (!options.actor) throw new Error('Serve requires an explicit provider actor for task, rule and Ask ownership.');
  const registry = require('../src/lib/agents/registry').activeRegistry({ ...process.env, TOOLSENABLED_STATE_ROOT: path.join(config.stateRoot, 'capability') });
  if (options.actor !== 'local' && !registry.has(options.actor)) throw new Error('Actor must be a described provider or local.');
  await runtime.serveHost(config, { actor: options.actor, treeKey: options.treeKey || null });
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.code || 'FLEET_V2_ERROR'}: ${error.message}\n`); process.exitCode = 1; });
module.exports = { main, parse };
