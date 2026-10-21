'use strict';
const base = require('./host-descriptions');

function briefToolSummary({ allowedNames = [] } = {}) {
  const ambient = process.env.TOOLSENABLED_FLEET_SECURITY === 'inherited-environment';
  const workers = allowedNames.includes('agent.spawn');
  const peer = allowedNames.includes('agent_comms.send_local');
  return { enabled: true, text: [
    `fleetV2 standalone MCP offers ${allowedNames.length} tools. Use the exact advertised Function IDs and schemas.`,
    workers ? (ambient ? 'Workers use provider bypass with approval prompts disabled and inherit this process environment and OS access restrictions. Fleet does not install a worker sandbox or elevate its permissions.' : 'Workers use provider bypass with approval prompts disabled. The saved explicit read/write policy constrains native worker processes and Fleet file tools.') : 'Worker launching is disabled for this connection.',
    ambient ? 'This session starts in the terminal working directory. Relative host file paths resolve there; absolute paths use existing OS access. The user supplies any external sandbox. Tasks, rules and Asks do not grant OS permissions.' : 'The configured folder policy is an operator declaration, not automatic detection of an arbitrary parent client. Do not infer folder authority from Ask, bypass, a task, a rule, or an answered Ask.',
    peer
      ? 'Read your current assignment and rules through fleet.control. Use its ask, progress and complete actions as advertised. You may message linked peers; messaging links do not confer lifecycle control.'
      : 'Coordinate workers through fleet.control assignments, rules and durable Asks. Do not send workers direct messages. Pause a worker, edit its assignment or rules, then resume it on the current revision. Use the advertised lifecycle tools to monitor, stop or remove workers.',
    ...(ambient ? [] : ['Folder policy changes require the local operator entry point. Active workers must quiesce and acquire the new revision before resuming; stale sessions cannot continue.']),
    'Use host.read_file before host.write_file or host.patch_file for byte-coordinated edits. Native and shell edits inherit OS restrictions but do not participate in byte mediation.',
    'ToolsEngine is a separate MCP. Its shared Fleet settings file can disable Chrome session transfer; transfer still requires explicit user authorization.',
    ambient ? 'If a tool or native provider path is unavailable, report that limitation. Fleet does not provide filesystem or network isolation in inherited-environment mode.' : 'If a tool or native provider path is unavailable, report that limitation. The person can inspect fleetV2 status or update the declared folder scope with the installed fleetV2 CLI.'
  ].join('\n') };
}
module.exports = { ...base, briefToolSummary };
