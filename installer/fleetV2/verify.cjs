'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

function verify(root = __dirname) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  assert.equal(manifest.name, 'fleetV2'); assert.equal(manifest.distribution, 'standalone-mcp');
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.ok(['linux-x64', 'windows-x64'].includes(manifest.target));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  const expected = new Set(['release.json']);
  for (const file of manifest.files) {
    assert.equal(typeof file.path, 'string');
    assert.ok(file.path && !file.path.includes('\\') && !file.path.startsWith('/') && !file.path.includes(':')
      && file.path.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!expected.has(file.path), `Duplicate file: ${file.path}`); expected.add(file.path);
    let cursor = root;
    for (const part of file.path.split('/')) { cursor = path.join(cursor, part); assert.equal(fs.lstatSync(cursor).isSymbolicLink(), false); }
    const stat = fs.lstatSync(cursor); assert.ok(stat.isFile()); assert.equal(stat.nlink, 1);
    const body = fs.readFileSync(cursor); assert.equal(body.length, file.size, file.path);
    assert.equal(crypto.createHash('sha256').update(body).digest('hex'), file.sha256, file.path);
  }
  function walk(folder, prefix = '') {
    for (const name of fs.readdirSync(folder)) {
      const relative = prefix + name; const full = path.join(folder, name); const stat = fs.lstatSync(full);
      assert.equal(stat.isSymbolicLink(), false, relative);
      if (stat.isDirectory()) walk(full, relative + '/');
      else assert.ok(expected.has(relative), `Unexpected entry: ${relative}`);
    }
  }
  walk(root);
  return { name: manifest.name, version: manifest.version, target: manifest.target, commit: manifest.commit,
    verifiedFiles: manifest.files.length, qualification: manifest.qualification };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(verify()) + '\n'); }
  catch (error) { process.stderr.write(`FLEET_V2_ARTIFACT_INVALID: ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { verify };
