'use strict';

// Where an OpenShell agent tree is kept, so it outlives the ToolsEnabled server
// that holds it.
//
// Each tree belongs to one root: the ToolsEnabled server a person's CLI
// (Claude Code or Codex) started in the sandbox. It lives in its own folder
// under the state root:
//
//   <state root>/openshell-tree/<tree key>/tree.json    the tree
//   <state root>/openshell-tree/<tree key>/owner.json   the live server holding it
//   <state root>/openshell-tree/<tree key>/link.sock    that server's tree link
//   <state root>/openshell-tree/<tree key>/nodes/<id>/  a worker's own tool files
//
// The tree key is the root's name (for example `claude` or `codex`), so the
// next server for the same CLI takes the same tree back: every worker it held
// is there, stopped, with the conversation it can be resumed into. When a live
// server already holds that key (a second session of the same CLI), the new
// one takes the next free key (`claude-2`) rather than share a tree with it.
//
// A server that ended without stopping its workers (killed outright) leaves
// their process identities in tree.json; the next load ends any of them that
// are still running, by pid and start time (src/lib/proc/process-group.js).
//
// Written atomically, folders 0700 and files 0600. Nothing here is a
// credential: a worker's link token lives in its own tool file and dies with
// that session.

const fs = require('node:fs');
const path = require('node:path');
const groups = require('./proc/process-group');
const { terminalDisplayText } = require('./terminal-safe-text');

const TREE_FOLDER = 'openshell-tree';
const DOCUMENT_VERSION = 1;
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_KEYS_PER_ROOT = 32;

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

function treeFolder(stateRoot) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw refusal('OPENSHELL_TREE_STATE_INVALID', 'The agent tree is kept under an absolute state folder.');
  }
  return path.join(stateRoot, TREE_FOLDER);
}

function privateFolder(folder) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(folder, 0o700); } catch { /* best effort on a shared mount */ }
  return folder;
}

function writePrivateJson(file, value) {
  privateFolder(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw refusal('OPENSHELL_TREE_UNREADABLE', `${path.basename(file)} for this agent tree could not be read: ${error.message}`);
  }
}

/** Is the server named in owner.json still that same running process? */
function ownerAlive(owner) {
  return Boolean(owner && Number.isSafeInteger(owner.pid) && owner.pid !== process.pid
    && groups.sameProcessAlive(owner.pid, owner.startTime));
}

function emptyDocument(treeKey, root) {
  return {
    v: DOCUMENT_VERSION,
    treeKey,
    root,
    counter: 0,
    nodes: [],
    inbox: [],
    updatedAt: new Date().toISOString(),
  };
}

/* A tree record this build can use: its version, a list of nodes that are
   each an object with an id, and a list of undelivered reports. */
function usableDocument(stored) {
  return Boolean(stored && typeof stored === 'object' && !Array.isArray(stored) && stored.v === DOCUMENT_VERSION
    && Array.isArray(stored.nodes)
    && stored.nodes.every(node => node && typeof node === 'object' && !Array.isArray(node) && typeof node.nodeId === 'string' && KEY.test(node.nodeId))
    && (stored.inbox === undefined || Array.isArray(stored.inbox)));
}

/* A RECORD THAT CANNOT BE USED IS SET ASIDE, NOT FATAL AND NOT OVERWRITTEN.
   The record is an ordinary file every process in the sandbox can write, and
   a truncated or edited one used to stop the ToolsEnabled server from
   starting at all, so the CLI had none of its tools. It is renamed next to
   itself, kept for the person, and the tree starts empty. */
function loadTreeDocument(treeFile, { treeKey, root, now }) {
  let stored = null;
  let reason = null;
  try {
    stored = readJson(treeFile);
    if (stored !== null && !usableDocument(stored)) reason = 'it is not an agent tree record this version can use';
  } catch (error) {
    reason = error.message;
  }
  if (reason === null) return stored || emptyDocument(treeKey, root);
  const keptAs = `${treeFile}.unreadable-${now().replace(/[^0-9A-Za-z]/g, '')}`;
  fs.renameSync(treeFile, keptAs);
  process.stderr.write(`[toolsenabled] the agent tree record ${treeFile} could not be used (${reason}); it was kept as ${keptAs} and the tree starts empty.\n`);
  return { ...emptyDocument(treeKey, root), setAside: { file: keptAs, reason: String(reason).slice(0, 500), at: now() } };
}

/* owner.json only names the server holding a tree. One that cannot be read
   names none, so the tree is free to take. */
function readOwner(ownerFile) {
  try { return readJson(ownerFile); } catch { return null; }
}

/**
 * Take the tree for one root, the base key or the first free one after it.
 * Returns the paths, the loaded (or new) document, and a release function.
 */
function acquireTree({ stateRoot, baseKey, root, now = () => new Date().toISOString() }) {
  if (!KEY.test(baseKey || '')) throw refusal('OPENSHELL_TREE_KEY_INVALID', 'An agent tree is named by a lowercase key.');
  const base = privateFolder(treeFolder(stateRoot));
  for (let index = 1; index <= MAX_KEYS_PER_ROOT; index += 1) {
    const treeKey = index === 1 ? baseKey : `${baseKey}-${index}`;
    const folder = path.join(base, treeKey);
    const ownerFile = path.join(folder, 'owner.json');
    if (ownerAlive(readOwner(ownerFile))) continue;
    privateFolder(folder);
    const owner = { pid: process.pid, startTime: groups.processStartTime(process.pid), since: now() };
    writePrivateJson(ownerFile, owner);
    // Two servers starting at the same moment: the later write wins the file,
    // and the earlier one moves on to the next key.
    const confirmed = readOwner(ownerFile);
    if (!confirmed || confirmed.pid !== process.pid) continue;
    const document = loadTreeDocument(path.join(folder, 'tree.json'), { treeKey, root, now });
    document.treeKey = treeKey;
    document.root = { ...(document.root || {}), ...root };
    return {
      treeKey,
      folder,
      treeFile: path.join(folder, 'tree.json'),
      socketPath: path.join(folder, 'link.sock'),
      nodeFolder: nodeId => path.join(folder, 'nodes', nodeId),
      document,
      release() {
        const current = readOwner(ownerFile);
        if (current && current.pid === process.pid) fs.rmSync(ownerFile, { force: true });
      },
    };
  }
  throw refusal('OPENSHELL_TREE_BUSY', `Every agent tree for ${baseKey} is held by a running server.`);
}

function saveTree(treeFile, document) {
  document.updatedAt = new Date().toISOString();
  writePrivateJson(treeFile, document);
}

/**
 * Bring a loaded tree to rest: every worker that was running when its server
 * ended is stopped now. Returns the processes that were still running and
 * were ended here.
 */
async function settleLoadedTree(document, { terminate = groups.terminateProcessTree, now = () => new Date().toISOString() } = {}) {
  const ended = [];
  for (const node of document.nodes) {
    if (node.process && Number.isSafeInteger(node.process.pid)) {
      const result = await terminate(node.process, { graceMs: 1500 });
      if (result.signalled.length > 0) ended.push({ nodeId: node.nodeId, pids: result.signalled });
      node.process = null;
    }
    if (node.state === 'running' || node.state === 'starting') {
      node.state = 'stopped';
      node.turn = 'none';
      node.stoppedReason = 'server-ended';
      node.sessionId = null;
      node.updatedAt = now();
    }
  }
  return ended;
}

/** Every tree under this state root, with whether a live server holds it. For `toolsenabled-openshell tree`. */
function listTrees(stateRoot) {
  const base = treeFolder(stateRoot);
  let keys;
  try { keys = fs.readdirSync(base).filter(name => KEY.test(name)).sort(); } catch { return []; }
  const trees = [];
  for (const treeKey of keys) {
    let document;
    let owner;
    try {
      document = readJson(path.join(base, treeKey, 'tree.json'));
      owner = readOwner(path.join(base, treeKey, 'owner.json'));
    } catch (error) {
      trees.push({ treeKey, error: error.message });
      continue;
    }
    if (!document) continue;
    trees.push({ treeKey, live: ownerAlive(owner) || Boolean(owner && owner.pid === process.pid), owner, document });
  }
  return trees;
}

function short(value, length) {
  const text = value === null || value === undefined || value === '' ? '-' : terminalDisplayText(value);
  const points = Array.from(text);
  return points.length > length ? `${points.slice(0, length - 1).join('')}~` : text;
}

/* A worker cannot outlive the server that holds its tree (its input closes
   and it exits), so with no server live a worker the record still calls
   running -- the sandbox was stopped before the server could write -- is
   stopped. The next server takes the tree back the same way. */
function viewState(node, live) {
  if (!live && (node.state === 'running' || node.state === 'starting')) return 'stopped';
  return node.state;
}

function stateWord(node, live = true) {
  const state = viewState(node, live);
  if (state === 'running') return node.turn === 'running' ? 'working' : 'idle';
  return state || '-';
}

function pendingText(key, value) {
  if (key === 'surface') {
    const names = value && Array.isArray(value.names) ? value.names : null;
    return names ? `[${short(names.join('|'), 160)}]` : '[unreadable]';
  }
  return terminalDisplayText(value);
}

/** The tree as lines a person reads in a terminal. */
function formatTrees(trees) {
  const lines = ['ToolsEnabled Fleet — Agent tree', ''];
  if (trees.length === 0) return [...lines, 'No agent tree yet. Agents appear here once a session starts one with agent.spawn.'];
  for (const tree of trees) {
    if (tree.error) { lines.push(`${terminalDisplayText(tree.treeKey)}  (unreadable: ${terminalDisplayText(tree.error)})`); continue; }
    const { document } = tree;
    const root = document.root || {};
    lines.push(`${terminalDisplayText(tree.treeKey)}  ${terminalDisplayText(root.displayName || tree.treeKey)}  ${terminalDisplayText(root.actor || '-')}  ${tree.live ? `live (server pid ${terminalDisplayText(tree.owner.pid)})` : 'no server running: workers are stopped'}`);
    const byParent = new Map();
    for (const node of document.nodes) {
      const parent = node.parentNodeId || 'root';
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(node);
    }
    const walk = (parentId, prefix) => {
      const children = byParent.get(parentId) || [];
      children.forEach((node, index) => {
        const last = index === children.length - 1;
        const pending = node.pending && Object.keys(node.pending).length > 0
          ? `  pending ${Object.entries(node.pending).map(([key, value]) => `${terminalDisplayText(key)}=${pendingText(key, value)}`).join(',')}` : '';
        lines.push(`${prefix}${last ? '`-- ' : '|-- '}${terminalDisplayText(node.nodeId)}  ${short(node.displayName, 24)}  ${terminalDisplayText(node.provider)}  ${short(node.model, 28)}`
          + `${node.effort ? `/${terminalDisplayText(node.effort)}` : ''}  role ${terminalDisplayText(node.role)}  ${terminalDisplayText(stateWord(node, tree.live))}  parent ${terminalDisplayText(parentId)}${pending}`);
        walk(node.nodeId, `${prefix}${last ? '    ' : '|   '}`);
      });
    };
    walk('root', '  ');
    const waiting = Array.isArray(document.inbox) ? document.inbox.filter(item => !item.deliveredAt).length : 0;
    if (waiting > 0) lines.push(`  ${waiting} report${waiting === 1 ? '' : 's'} waiting for the root session`);
    if (document.setAside && typeof document.setAside.file === 'string') {
      lines.push(`  an earlier record of this tree could not be used and was kept as ${terminalDisplayText(document.setAside.file)}`);
    }
  }
  return lines;
}

module.exports = Object.freeze({
  TREE_FOLDER,
  treeFolder,
  writePrivateJson,
  acquireTree,
  saveTree,
  settleLoadedTree,
  listTrees,
  formatTrees,
  viewState,
});
