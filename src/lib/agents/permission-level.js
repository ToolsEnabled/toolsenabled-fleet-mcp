'use strict';

/* FLEET SETS NO PERMISSIONS. IT ONLY MAKES SURE A WORKER NEVER GETS MORE.
 *
 * The person starts their lead agent however they like -- normal mode, an
 * auto-edit mode, or with every prompt and limit off. Fleet reads which of four
 * levels that is from the lead's own command line, and every worker below it
 * starts at that level or lower (its role can lower it further):
 *
 *   1 read only   2 asks   3 edits on its own   4 everything
 *
 * "Asks" is the agent's normal mode. A worker has no one to ask, so whatever
 * would prompt is declined. When the lead's level cannot be read, Fleet uses 2:
 * it declines what would prompt and never widens.
 *
 * Lead detection reads only the command line (/proc/<pid>/cmdline), never an
 * agent's settings. Native tool removals may preserve system settings in a
 * private worker overlay; sign-in files are never a source for that overlay. */

const fs = require('node:fs');
const path = require('node:path');

const LEVEL = Object.freeze({ READ_ONLY: 1, ASKS: 2, EDITS: 3, EVERYTHING: 4 });
const DEFAULT_LEVEL = LEVEL.ASKS;
const LEVEL_NAMES = Object.freeze({ 1: 'read only', 2: 'asks', 3: 'edits on its own', 4: 'everything' });
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3']);
// Programs that only start another program. Fleet looks through these to the
// agent that started it, and stops at anything else.
const WRAPPERS = new Set(['sh', 'bash', 'dash', 'zsh', 'env', 'npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'timeout', 'nice', 'setsid', 'stdbuf']);
const WRAPPER_SCRIPTS = new Set(['npx-cli.js', 'npm-cli.js', 'npx', 'npm']);
const MAX_ANCESTORS = 6;
const programName = value => {
  const name = path.basename(String(value));
  return process.platform === 'win32' ? name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '') : name;
};

function isLevel(value) {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** The lower of the given levels; anything that is not a level is ignored. */
function narrowest(...levels) {
  const valid = levels.filter(isLevel);
  return valid.length ? Math.min(...valid) : DEFAULT_LEVEL;
}

/** Options and flags in an argument list: `--opt value`, `--opt=value`, `--flag`. */
function parseArgv(argv, aliases = {}, { booleanNegation = false, booleans = [] } = {}) {
  const options = new Map();
  const flags = new Set();
  const booleanNames = new Set(booleans);
  const canonical = word => (Object.hasOwn(aliases, word) ? aliases[word] : word);
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    // Everything after the option terminator is positional input, even if it
    // spells a permission flag. Prompt text must never grant worker authority.
    if (word === '--') break;
    if (typeof word !== 'string' || !word.startsWith('-') || word === '-') continue;
    if (booleanNegation && word.startsWith('--no-')) {
      const positive = canonical(`--${word.slice(5)}`);
      if (booleanNames.has(positive)) {
        flags.delete(positive);
        options.set(positive, 'false');
        continue;
      }
    }
    const equals = word.indexOf('=');
    if (equals > 0) {
      const name = canonical(word.slice(0, equals)), value = word.slice(equals + 1);
      options.set(name, value);
      if (booleanNegation && booleanNames.has(name)) {
        flags.delete(name);
        if (value === 'true') flags.add(name);
      }
      continue;
    }
    const name = canonical(word);
    const next = argv[index + 1];
    if (booleanNegation && booleanNames.has(name) && ['true', 'false'].includes(next)) {
      flags.delete(name);
      if (next === 'true') flags.add(name);
      options.set(name, next);
      index += 1;
      continue;
    }
    flags.add(name);
    if (typeof next === 'string' && !next.startsWith('-')) options.set(name, next);
  }
  return { options, flags };
}

/** The level an agent's own command line starts it at, by its descriptor's rules. */
function levelFromArgv(descriptor, argv) {
  // Some CLI short options accept attached values. Only normalize described
  // value options; arbitrary prompt words never become options.
  const syntax = descriptor.permissions.argv || {};
  const words = argv.flatMap(word => (syntax.attachedValueOptions || []).some(option =>
    word.startsWith(option) && word.length > option.length && word[option.length] !== '=')
    ? [word.slice(0, 2), word.slice(2)] : [word]);
  const { options, flags } = parseArgv(words, descriptor.permissions.aliases, {
    booleanNegation: syntax.booleanNegation === true,
    booleans: descriptor.permissions.lead.flatMap(rule =>
      Object.entries(rule.when).filter(([, value]) => value === true).map(([name]) => name)),
  });
  // Explicit read-only config overrides can narrow inheritance. This is not
  // a general TOML/settings parser, and no config override grants authority.
  if (syntax.readOnlyConfig) {
    const config = syntax.readOnlyConfig;
    for (let index = 0; index < words.length && words[index] !== '--'; index += 1) {
      const word = words[index];
      const option = config.options.find(name => word === name || word.startsWith(name + '=')
        || /^-[A-Za-z]$/.test(name) && word.startsWith(name) && word.length > name.length);
      const value = option === word ? words[index + 1] : option ? word.slice(option.length).replace(/^=/, '') : null;
      const assignment = typeof value === 'string' && /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([\s\S]*?)\s*$/.exec(value);
      if (assignment && assignment[1] === config.key) {
        // Recognize plain/raw strings and quoted TOML scalars with comments.
        // More complicated TOML (including multiline or unsupported escapes)
        // is conservatively read-only rather than guessed to permit edits.
        const raw = assignment[2];
        let scalar = null;
        const basic = /^("(?:[^"\\]|\\.)*")\s*(?:#[^\r\n]*)?$/.exec(raw);
        const literal = /^'([^']*)'\s*(?:#[^\r\n]*)?$/.exec(raw);
        if (basic) { try { scalar = JSON.parse(basic[1]); } catch { /* narrower fallback */ } }
        else if (literal) scalar = literal[1];
        else if (/^[A-Za-z0-9_.-]+$/.test(raw)) scalar = raw;
        if (scalar === null || scalar === config.value) return LEVEL.READ_ONLY;
      }
    }
  }
  for (const rule of descriptor.permissions.lead) {
    const matches = Object.entries(rule.when).every(([option, value]) => (value === true
      ? flags.has(option)
      : options.get(option) === value));
    if (matches) return rule.level;
  }
  return DEFAULT_LEVEL;
}

/** Which described agent a process's argv belongs to, or null. */
function agentOfArgv(registry, argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const first = programName(argv[0]);
  let script = 1;
  // Node can relaunch a CLI with a heap limit before its entry point. Only
  // skip this numeric runtime option; searching arbitrary arguments could
  // mistake an eval string or another program's argument for an agent.
  if (first === 'node' || first === 'nodejs') {
    while (/^--max[-_]old[-_]space[-_]size=\d+$/.test(argv[script] || '')) script += 1;
    if (/^--max[-_]old[-_]space[-_]size$/.test(argv[script] || '') && /^\d+$/.test(argv[script + 1] || '')) script += 2;
  }
  const program = INTERPRETERS.has(first) && argv.length > script ? programName(argv[script]) : first;
  return registry.agents.find(agent => program === agent.command || program === `${agent.command}.js`) || null;
}

function readCmdline(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  return raw.split('\0').filter((word, index, all) => index < all.length - 1 || word !== '');
}

function readParent(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[1]);
}

function isWrapper(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  const first = programName(argv[0]);
  if (process.platform === 'win32' && ['cmd', 'powershell', 'pwsh'].includes(first)) return true;
  if (WRAPPERS.has(first)) return true;
  return INTERPRETERS.has(first) && argv.length > 1 && WRAPPER_SCRIPTS.has(path.basename(String(argv[1])));
}

/* The lead agent that started this process: the parent, looking through
   launch wrappers (sh -c, env, npx, ...), whose program is a described agent,
   and the level its own flags start it at. Null when whatever started Fleet is
   not an agent (another MCP client, a test runner, a platform without /proc). */
function findLead({ registry, startPid = process.ppid, read = readCmdline, parent = readParent } = {}) {
  if (process.platform === 'win32' && read === readCmdline && parent === readParent) {
    const rows = require('./windows-lead-processes').readWindowsLeadProcesses(startPid);
    if (!rows) return null;
    read = pid => rows.get(pid)?.argv;
    parent = pid => rows.get(pid)?.parent;
  }
  let pid = startPid;
  for (let step = 0; step < MAX_ANCESTORS && Number.isInteger(pid) && pid > 1; step += 1) {
    let argv;
    try { argv = read(pid); } catch { return null; }
    const agent = agentOfArgv(registry, argv);
    if (agent) return Object.freeze({ agentId: agent.id, pid, level: levelFromArgv(agent, argv.slice(1)) });
    if (!isWrapper(argv)) return null;
    try { pid = parent(pid); } catch { return null; }
  }
  return null;
}

/* The level the lead runs at, for this process. A lead Fleet cannot identify is
   level 2. TOOLSENABLED_LEVEL_CAP can only lower it: an environment variable is
   never a way to widen what the lead was started with. */
function leadLevel({ registry, env = process.env, ...options } = {}) {
  const lead = findLead({ registry, ...options });
  const detected = lead ? lead.level : DEFAULT_LEVEL;
  const cap = Number(env.TOOLSENABLED_LEVEL_CAP);
  return Object.freeze({
    agentId: lead ? lead.agentId : null,
    detected,
    level: isLevel(cap) ? narrowest(detected, cap) : detected
  });
}

// Diagnostics are separate from the long-standing leadLevel return contract.
// An unknown GUI/remote parent is not proof of the default level: label the
// fallback explicitly and never manufacture a wider inherited permission.
function leadPermissionContext(options = {}) {
  const lead = findLead(options);
  const detected = lead ? lead.level : DEFAULT_LEVEL;
  const cap = Number((options.env || process.env).TOOLSENABLED_LEVEL_CAP);
  const result = { agentId: lead ? lead.agentId : null, detected,
    level: isLevel(cap) ? narrowest(detected, cap) : detected };
  return Object.freeze({ ...result,
    source: lead ? 'ancestor-cli' : 'unknown-parent-fallback',
    verifiedParent: Boolean(lead),
    permissionPolicyVerified: false,
    reason: lead ? 'level-derived-from-cli-arguments' : 'parent-cli-not-observable',
    fallback: !lead,
    cap: isLevel(Number((options.env || process.env).TOOLSENABLED_LEVEL_CAP))
      ? Number((options.env || process.env).TOOLSENABLED_LEVEL_CAP) : null,
  });
}

/** How to start this agent as a worker at a level, from its descriptor. */
/* The exact options that start a lead at level 4, read from its own
   descriptor, for refusal text only: the lead Fleet found, or every described
   agent when it found none (another MCP client, a test runner). Fleet changes
   no option; the person restarts their own lead if they choose to. */
function noPromptsHint({ registry, lead } = {}) {
  if (!registry) return 'start your lead with its no-prompts setting';
  if (lead === undefined) lead = findLead({ registry })?.agentId || null;
  const options = agent => agent.permissions.lead.filter(rule => rule.level === 4)
    .map(rule => Object.entries(rule.when).map(([name, value]) => value === true ? name : `${name} ${value}`).join(' '));
  const agents = lead && registry.get(lead) ? [registry.get(lead)] : registry.agents;
  const named = agents.map(agent => [agent.name, options(agent)]).filter(([, rows]) => rows.length)
    .map(([name, rows]) => `${name}: ${rows.join(' or ')}`);
  return named.length ? `start your lead with its no-prompts setting (${named.join('; ')})` : 'start your lead with its no-prompts setting';
}

/** Refuse a worker below its agent's described minimum level; never widen. */
function assertWorkerLevel(descriptor, level, { registry, lead } = {}) {
  const minimum = descriptor.permissions.workerMinimum;
  if (minimum && level < minimum.level) {
    throw Object.assign(new Error(`${minimum.reason} This worker inherited level ${level} (${LEVEL_NAMES[level]}) and ${descriptor.name} workers need level ${minimum.level} (${LEVEL_NAMES[minimum.level]}), so it was not started; Fleet never widens a level. Choose another agent for this worker, or ${noPromptsHint({ registry, lead })}.`),
      { code: 'AGENT_WORKER_LEVEL_UNAVAILABLE' });
  }
}

function workerSettings(descriptor, level) {
  if (!isLevel(level)) throw Object.assign(new Error('A worker level must be 1 to 4.'), { code: 'AGENT_LEVEL_INVALID' });
  return descriptor.permissions.worker[level];
}

// Roles name categories, not vendor tool names. Inheritance can only add removals.
const NATIVE_TOOL_CATEGORIES = Object.freeze(['shell', 'web', 'subagents']);
function nativeToolRemovals(...lists) {
  for (const list of lists) {
    if (list !== undefined && (!Array.isArray(list) || list.some(value => !NATIVE_TOOL_CATEGORIES.includes(value)))) {
      throw Object.assign(new Error('removeNativeTools must contain only shell, web or subagents.'), { code: 'AGENT_NATIVE_TOOLS_INVALID' });
    }
  }
  return Object.freeze(NATIVE_TOOL_CATEGORIES.filter(category => lists.some(list => list?.includes(category))));
}

function nativeRemovalSettings(descriptor, removals = []) {
  // Native delegation is never a role choice: only Fleet may grow the tree.
  const categories = nativeToolRemovals(removals, ['subagents']);
  const args = [], overrides = {}, rejectKinds = [], settings = [];
  let env = {};
  for (const category of categories) {
    const removal = descriptor.permissions.remove?.[category];
    if (!removal || removal.unavailable) throw Object.assign(new Error(`${descriptor.name} cannot remove native ${category} tools, so this worker was not started.${removal?.unavailable ? ` ${removal.unavailable}` : ''}`),
      { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE' });
    args.push(...(removal.args || []));
    for (const [key, value] of Object.entries(removal.overrides || {})) {
      if (Object.hasOwn(overrides, key) && overrides[key] !== value) {
        throw Object.assign(new Error(`${descriptor.name} has conflicting native ${category} removals, so this worker was not started.`),
          { code: 'AGENT_NATIVE_TOOLS_UNAVAILABLE' });
      }
      overrides[key] = value;
    }
    rejectKinds.push(...(removal.rejectKinds || []));
    env = require('./native-removal-environment').mergeRemovalEnvironment(env, removal.env || {});
    if (removal.settings) settings.push(removal.settings);
  }
  return Object.freeze({ args: Object.freeze(args), overrides: Object.freeze(overrides),
    ...(descriptor.permissions.workerAgent ? { workerAgent: descriptor.permissions.workerAgent } : {}),
    env: Object.freeze(env), settings: Object.freeze(settings), rejectKinds: Object.freeze([...new Set(rejectKinds)]) });
}

module.exports = Object.freeze({
  LEVEL, LEVEL_NAMES, DEFAULT_LEVEL, isLevel, narrowest,
  NATIVE_TOOL_CATEGORIES, nativeToolRemovals, nativeRemovalSettings,
  parseArgv, levelFromArgv, agentOfArgv, findLead, leadLevel, leadPermissionContext, workerSettings, assertWorkerLevel, noPromptsHint
});
