#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { realpathSync } = require('node:fs');
const runtime = require('./src/lib/host-runtime');
const allowedToolNames = Object.freeze([...require('./.codex-plugin/policy.json').allowedTools]);

function coreConfig(env, readConfig = runtime.readHostConfig, real = realpathSync) {
  const state = env.FLEET_MCP_CODEX_STATE_ROOT, workspace = env.FLEET_MCP_CODEX_WORKSPACE;
  if (!state || !workspace || !path.isAbsolute(state) || !path.isAbsolute(workspace))
    throw new Error('FLEET_MCP_CODEX_CONFIG_REQUIRED: set absolute FLEET_MCP_CODEX_STATE_ROOT and FLEET_MCP_CODEX_WORKSPACE.');
  const config = readConfig(state, { setupKind: 'plugin' });
  if (config.workers !== false) throw new Error('FLEET_MCP_CODEX_WORKERS_REFUSED: configure a separate workers-off core.');
  if (config.tier !== 'standard') throw new Error('FLEET_MCP_CODEX_TIER_REFUSED: this package requires the Standard tier.');
  if (real(workspace) !== real(config.workspace))
    throw new Error('FLEET_MCP_CODEX_WORKSPACE_REFUSED: select the exact configured project directory, not its child or parent.');
  return config;
}
async function main({ env = process.env, readConfig, real, serve = runtime.serveHost, enterWorkspace = process.chdir } = {}) {
  process.umask(0o077);
  const config = coreConfig(env, readConfig, real);
  // Keep relative arguments inside the same canonical selected project.
  enterWorkspace(config.workspace);
  return serve(config, { actor: 'codex', allowedToolNames });
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { coreConfig, main };
