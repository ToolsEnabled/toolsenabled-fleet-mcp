'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = process.env.FLEET_PACKAGED_ENGINE || path.resolve(__dirname, '..');
const fromEngine = name => require(path.join(engine, name));
const { spawnSync } = require('node:child_process');

test('native Windows parent argv is observed with delimiter, role-cap and unknown-parent protection', {
  skip: process.platform !== 'win32', timeout: 120000,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-win-argv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const observer = path.join(root, 'observe.cjs');
  fs.writeFileSync(observer, `
    const levels=require(${JSON.stringify(require.resolve(path.join(engine, 'src/lib/agents/permission-level')))});
    const registry=require(${JSON.stringify(require.resolve(path.join(engine, 'src/lib/agents/registry')))}).loadRegistry();
    process.stdout.write(JSON.stringify(levels.leadPermissionContext({registry})));
  `);
  const launcher = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,[${JSON.stringify(observer)}],{stdio:'inherit',windowsHide:true});
    child.on('exit',code=>{process.exitCode=code;});`;
  const known = path.join(root, 'codex.js'), unknown = path.join(root, 'unrelated.js');
  fs.writeFileSync(known, launcher); fs.writeFileSync(unknown, launcher);
  for (const [file, args, expected, cap] of [
    [known, ['--sandbox', 'read-only', '--', '--yolo'], 1],
    [known, ['--yolo'], 4],
    [known, ['--yolo'], 1, '1'],
    [unknown, ['--yolo'], 2],
  ]) {
    const env = { ...process.env };
    delete env.TOOLSENABLED_LEVEL_CAP;
    if (cap) env.TOOLSENABLED_LEVEL_CAP = cap;
    const result = spawnSync(process.execPath, [file, ...args], {
      encoding: 'utf8', timeout: 25000, env, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.level, expected, JSON.stringify(observed));
    assert.equal(observed.verifiedParent, file === known);
    assert.equal(observed.fallback, file === unknown);
  }
});
