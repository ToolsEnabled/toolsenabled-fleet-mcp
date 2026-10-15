#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { realpathSync } = require('node:fs');
const runtime = require('./src/lib/host-runtime');

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
async function main({ env = process.env, readConfig, real, serve = runtime.serveHost } = {}) {
  process.umask(0o077);
  return serve(coreConfig(env, readConfig, real), { actor: 'codex' });
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
module.exports = { coreConfig, main };
