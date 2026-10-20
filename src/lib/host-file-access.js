'use strict';

// The dispatch binds this scope from its transport's effective session, never
// from tool arguments. Each async file operation keeps its own ceiling.
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const authorizations = new WeakMap();

function create({ fileToolContext, permissionSession, observation, env = process.env } = {}) {
  const session = require('./permission-tier-policy').session(permissionSession);
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
      || session.origin !== 'local' || session.tier !== 'full'
      || observation?.verifiedParent !== true || observation?.source !== 'ancestor-cli'
      || observation?.level !== 4) return undefined;
  require('./file-tool-context').requireFileToolContext(fileToolContext);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { fileToolContext });
  return authorization;
}

function createInherited({ fileToolContext, resolve, env = process.env } = {}) {
  if (env.TOOLSENABLED_RUNTIME_MODE !== 'host' || env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin'
      || typeof resolve !== 'function') return undefined;
  require('./file-tool-context').requireFileToolContext(fileToolContext);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { fileToolContext, resolve, admitted: false });
  return authorization;
}

function bound(context) {
  const authorization = authorizations.get(context?.hostFileAuthorization);
  return authorization?.fileToolContext === context?.fileToolContext ? authorization : null;
}

async function prepare(context) {
  const authorization = bound(context);
  if (!authorization?.resolve || context?.setupKind === 'plugin' || context?.researchAccess) return context;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  authorization.admitted = await authorization.resolve() === true;
  if (!authorization.admitted) return context;
  const records = require('./setup/machine-record');
  const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
  // This is a live authenticated inheritance result, not a guessed parent
  // level. The saved setup and role/function checks still narrow the call.
  return { ...context, permissionSession: require('./permission-tier-policy').effectiveSessionFromRecord(4, record) };
}

function run(context, callback) {
  const session = require('./permission-tier-policy').session(context?.permissionSession);
  const authorization = bound(context);
  return scope.run(authorization
    && session.origin === 'local' && session.tier === 'full'
    && require('./providers/host-control').hostByteMediationEnabled()
    && !context?.researchAccess && context?.setupKind !== 'plugin' ? authorization : null, callback);
}

function unrestricted() {
  const authorization = scope.getStore();
  if (!authorization || process.env.TOOLSENABLED_RUNTIME_MODE !== 'host'
      || process.env.TOOLSENABLED_HOST_SETUP_KIND === 'plugin') return false;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  assertCurrent();
  // Re-read the sealed setup at every path/publication check: a downgrade or
  // unreadable record cannot retain the broader scope of an earlier call.
  const records = require('./setup/machine-record');
  const record = records.readMachineRecord({ servicesRoot: records.resolveServicesRoot({}), adopt: false });
  return Boolean(record && require('./permission-tier-policy').installTierFromRecord(record) === 'unrestricted');
}

function assertCurrent() {
  const authorization = scope.getStore();
  if (!authorization) return;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  if (authorization.resolve && !authorization.admitted) {
    throw Object.assign(new Error('The worker no longer inherits unrestricted file access.'), { code: 'HOST_FILE_ACCESS_REVOKED' });
  }
}

async function refresh() {
  const authorization = scope.getStore();
  if (!authorization) return;
  require('./file-tool-context').requireFileToolContext(authorization.fileToolContext);
  if (authorization.resolve) authorization.admitted = await authorization.resolve() === true;
  assertCurrent();
}

// Resource syntax is separate from access authorization. Host adapters check
// the live session again before reading/publishing; the journal can validate
// its resource names even when their original transport has closed.
function resourcePath(value, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? require('node:path').win32 : require('node:path');
  if (typeof value !== 'string' || !paths.isAbsolute(value) || value.includes('\0')) {
    throw Object.assign(new Error('A host resource needs an absolute local file path.'), { code: 'HOST_PATH_INVALID' });
  }
  if (platform !== 'win32') return paths.normalize(value);
  const local = value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  const normalized = paths.normalize(local);
  const parts = normalized.slice(3).split('\\');
  if (!/^[a-z]:\\/i.test(normalized)
      || parts.some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw Object.assign(new Error('Host file tools require ordinary local drive paths; network, device and alternate-stream paths are unsupported.'),
      { code: 'HOST_PATH_INVALID' });
  }
  return normalized;
}

module.exports = { create, createInherited, prepare, run, unrestricted, assertCurrent, refresh, resourcePath };
