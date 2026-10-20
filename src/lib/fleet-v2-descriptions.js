'use strict';
const base = require('./host-descriptions');

function briefToolSummary({ allowedNames = [] } = {}) {
  const workers = allowedNames.includes('agent.spawn');
  const peer = allowedNames.includes('agent_comms.send_local');
  return { enabled: true, text: [
    `fleetV2 standalone MCP offers ${allowedNames.length} tools. Use the exact advertised Function IDs and schemas.`,
    workers ? 'Workers use provider bypass with approval prompts disabled. Folder authority is separate: the saved explicit parent read/write policy constrains native worker processes and Fleet file tools.' : 'Worker launching is disabled for this connection.',
    'The configured folder policy is an operator declaration, not automatic detection of an arbitrary parent client. Do not infer folder authority from Ask, bypass, a task, a rule, or an answered Ask.',
    peer
      ? 'Read your current assignment and rules through fleet.control. Use its ask, progress and complete actions as advertised. You may message linked peers; messaging links do not confer lifecycle control.'
      : 'Coordinate workers through fleet.control assignments, rules and durable Asks. Do not send workers direct messages. Pause a worker, edit its assignment or rules, then resume it on the current revision. Use the advertised lifecycle tools to monitor, stop or remove workers.',
    'Folder policy changes require the local operator entry point. Active workers must quiesce and acquire the new revision before resuming; stale sessions cannot continue.',
    'Use host.read_file before host.write_file or host.patch_file for byte-coordinated edits across authorized folders. Native and shell edits obey the process folder boundary but do not participate in byte mediation.',
    'ToolsEngine is a separate MCP. Its shared Fleet settings file can disable Chrome session transfer; transfer still requires explicit user authorization.',
    'If a tool or native provider path is unavailable, report that limitation. This runtime does not provide network isolation. The person can inspect fleetV2 status or update the declared folder scope with the installed fleetV2 CLI.'
  ].join('\n') };
}
module.exports = { ...base, briefToolSummary };
