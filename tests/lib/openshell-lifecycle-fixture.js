'use strict';

// Test seam only. Product code always uses its fixed per-uid namespace.
// Redirect precisely the Python lock script in Node's spawnSync call; all
// other commands and arguments retain their real behavior.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../../src/lib/openshell_lifecycle_lock.py');
const NAMESPACE_LINE = "    return '/tmp/toolsenabled-fleet-lifecycle-' + str(os.getuid())";

function configure(env, t) {
  if (!env || !t || typeof t.after !== 'function') throw new TypeError('Explicit fixture environment and test cleanup are required');
  const isolatedRoot = env.TOOLSENABLED_TEST_ROOT;
  if (env.TOOLSENABLED_TEST_ISOLATED !== '1' || !path.isAbsolute(isolatedRoot || '')) {
    throw new Error('Configure the isolated environment before the lifecycle fixture');
  }
  // A sibling of the caller's root stays outside that fixture's snapshots.
  const root = fs.mkdtempSync(path.join(path.dirname(isolatedRoot), '.fleet-lifecycle-fixture-'));
  fs.chmodSync(root, 0o700);
  const rootIdentity = fs.lstatSync(root);
  const namespace = path.join(root, 'mutex');
  const script = path.join(root, 'openshell_lifecycle_lock.py');
  const preload = path.join(root, 'preload.cjs');
  const source = fs.readFileSync(SCRIPT, 'utf8');
  if (source.split(NAMESPACE_LINE).length !== 2) {
    fs.rmdirSync(root);
    throw new Error('Lifecycle namespace source changed; review the private test seam before running');
  }
  fs.writeFileSync(script, source.replace(NAMESPACE_LINE, `    return ${JSON.stringify(namespace)}`), { mode: 0o600, flag: 'wx' });
  const program = `'use strict';
const cp = require('node:child_process');
const original = cp.spawnSync;
const production = ${JSON.stringify(SCRIPT)};
const fixture = ${JSON.stringify(script)};
cp.spawnSync = function (file, args, options) {
  if (file === '/usr/bin/python3' && Array.isArray(args) && args[0] === production) {
    return original.call(this, file, [fixture, ...args.slice(1)], options);
  }
  return original.apply(this, arguments);
};
`;
  fs.writeFileSync(preload, program, { mode: 0o600, flag: 'wx' });
  const ownedFiles = new Map([script, preload].map(file => [file, fs.lstatSync(file)]));
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    if (!same(fs.lstatSync(root), rootIdentity)) throw new Error('Lifecycle fixture root changed; retained');
    const names = fs.readdirSync(root);
    if (names.some(name => !['mutex', path.basename(script), path.basename(preload)].includes(name))) {
      throw new Error('Unexpected lifecycle fixture entry; retained for inspection');
    }
    if (fs.existsSync(namespace)) {
      const directory = fs.lstatSync(namespace);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== os.userInfo().uid) {
        throw new Error('Lifecycle fixture namespace changed; retained');
      }
      const entries = fs.readdirSync(namespace);
      if (entries.some(name => !['lock', 'pending.json'].includes(name) && !/^\.pending-[a-f0-9]{32}$/.test(name))) {
        throw new Error('Unexpected lifecycle fixture mutex entry; retained');
      }
      for (const name of entries) {
        const file = path.join(namespace, name);
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== os.userInfo().uid || info.nlink !== 1) {
          throw new Error('Lifecycle fixture mutex entry changed; retained');
        }
      }
      for (const name of entries) fs.unlinkSync(path.join(namespace, name));
      fs.rmdirSync(namespace);
    }
    for (const [file, expected] of ownedFiles) {
      if (!same(fs.lstatSync(file), expected)) throw new Error('Lifecycle fixture source changed; retained');
    }
    for (const file of ownedFiles.keys()) fs.unlinkSync(file);
    fs.rmdirSync(root);
    cleaned = true;
  };
  t.after(cleanup);
  env.NODE_OPTIONS = [env.NODE_OPTIONS || '', `--require ${JSON.stringify(preload)}`].filter(Boolean).join(' ');
  env.PYTHONDONTWRITEBYTECODE = '1';
  delete env.TOOLSENABLED_FLEET_LOCK_FD;
  delete env.TOOLSENABLED_FLEET_LOCK_NONCE;
  return Object.freeze({ root, namespace, script, preload, pendingPath: path.join(namespace, 'pending.json'), cleanup });
}

module.exports = Object.freeze({ configure });
