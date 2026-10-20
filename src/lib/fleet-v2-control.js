'use strict';

// One retained control record per tree. Root lifecycle authority is independent
// of the worker messaging graph. All edits are revision checked and serialized.
const clone = value => JSON.parse(JSON.stringify(value));
function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function text(value, label, maximum = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    refuse('FLEET_CONTROL_TEXT_INVALID', `${label} must be nonempty text of at most ${maximum} characters.`);
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
    refuse('FLEET_CONTROL_ID_INVALID', 'Use a bounded tree record id.');
  return value;
}
function createFleetControl({ document, persist, rootSessionId, command, settings, resources, inspect = () => document.nodes.map(({ nodeId, state, sessionId }) => ({ nodeId, state, sessionId })), now = () => new Date().toISOString() }) {
  if (!document.fleetControl) document.fleetControl = { v: 1, revision: 0, tasks: {}, rules: {}, asks: {} };
  const valid = value => value && typeof value === 'object' && !Array.isArray(value);
  const state = () => {
    const value = document.fleetControl;
    if (value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !['tasks', 'rules', 'asks'].every(key => valid(value[key])))
      refuse('FLEET_CONTROL_STORE_INVALID', 'The retained control record is invalid; it was preserved.');
    return value;
  };
  state();
  let queue = Promise.resolve();
  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function commit(edit) {
    const before = document.fleetControl;
    const next = clone(state());
    edit(next);
    next.revision += 1;
    next.updatedAt = now();
    document.fleetControl = next;
    try { persist(document); } catch (error) { document.fleetControl = before; throw error; }
    return clone(next);
  }
  function assignment(nodeId) {
    const value = state();
    const task = value.tasks[nodeId];
    if (!task || task.status === 'removed') return null;
    const rules = Object.entries(value.rules).filter(([, rule]) => rule.active).map(([id, rule]) => `${id}: ${rule.text}`);
    const asks = Object.entries(value.asks).filter(([, ask]) => ask.nodeId === nodeId && ask.status === 'answered')
      .map(([id, ask]) => `${id}: ${ask.question}\nAnswer: ${ask.answer}`);
    const policies = value.policies || {};
    const rendered = [`Durable assignment revision ${value.revision}`, task.text,
      'Report durable progress or completion using fleet.control with action progress or complete and text. For a blocking question, file a durable ask using fleet.control with action ask, a stable unique id, and question. The orchestrator answers in the retained record. Workers may message their linked peers.',
      ...(Object.keys(policies).length ? ['Orchestration policy (behavioral instructions):', JSON.stringify(policies)] : []),
      ...(rules.length ? ['Standing rules:', ...rules] : []), ...(asks.length ? ['Answered asks:', ...asks] : [])].join('\n\n');
    if (rendered.length > 12000) refuse('FLEET_ASSIGNMENT_TOO_LARGE', 'Assignment, active rules and answers exceed the worker brief limit; shorten them before resuming.');
    return { revision: value.revision, completed: task.status === 'completed', taskRevision: task.taskRevision || 1, text: rendered };
  }
  function assertRoot(sessionId) {
    if (sessionId !== rootSessionId) refuse('FLEET_CONTROL_ROOT_REQUIRED', 'Only this tree orchestrator may edit assignments, rules, answers and settings or control lifecycle.');
  }
  function request(input = {}, sessionId) {
    return serial(async () => {
      const action = input.action;
      if (action === 'resources-read') {
        assertRoot(sessionId);
        return { revision: state().revision, policy: require('./fleet-v2-resources').validatePolicy(state().resources || { mode: 'off' }), runtime: resources?.snapshot() || null };
      }
      if (action === 'settings-read') {
        assertRoot(sessionId);
        return { revision: state().revision, policies: clone(state().policies || {}), catalogue: require('./fleet-v2-settings').inventory.entries.map(({ id, disposition, reason, original }) => ({ id, disposition, reason, control: original.control, default: original.default, ...(original.options ? { options: original.options } : {}) })) };
      }
      if (action === 'read') {
        const value = clone(state());
        if (sessionId === rootSessionId) return { ...value, workers: inspect(), pendingAsks: Object.entries(value.asks).filter(([, ask]) => ask.status === 'open').map(([id, ask]) => ({ id, ...ask })) };
        const node = document.nodes.find(node => node.sessionId === sessionId && node.state === 'running');
        if (!node) refuse('FLEET_CONTROL_SESSION_INVALID', 'The worker session is no longer active.');
        return { revision: value.revision, assignment: assignment(node.nodeId), asks: Object.fromEntries(Object.entries(value.asks).filter(([, ask]) => ask.nodeId === node.nodeId)) };
      }
      if (action === 'progress' || action === 'complete') {
        const node = sessionId === rootSessionId
          ? document.nodes.find(node => node.nodeId === input.nodeId)
          : document.nodes.find(node => node.sessionId === sessionId && node.state === 'running');
        if (!node || !state().tasks[node.nodeId]) refuse('FLEET_CONTROL_SESSION_INVALID', 'Progress belongs to a retained assigned worker.');
        text(input.text, action === 'complete' ? 'Completion' : 'Progress');
        if (sessionId === rootSessionId && input.expectedRevision !== state().revision)
          refuse('FLEET_CONTROL_STALE_REVISION', 'Read the latest control revision before changing it.');
        return commit(value => { const task = value.tasks[node.nodeId]; task.progress = input.text; task.progressAt = now(); if (action === 'complete') task.status = 'completed'; });
      }
      if (action === 'ask') {
        const node = document.nodes.find(node => node.sessionId === sessionId && node.state === 'running');
        if (!node) refuse('FLEET_CONTROL_WORKER_REQUIRED', 'Only an active worker may file an ask.');
        identifier(input.id); text(input.question, 'Question', 4000);
        const existing = Object.hasOwn(state().asks, input.id) ? state().asks[input.id] : null;
        if (existing) {
          if (existing.nodeId !== node.nodeId || existing.question !== input.question) refuse('FLEET_ASK_REPLAY_CONFLICT', 'This ask id already names another question.');
          return { revision: state().revision, id: input.id, ...clone(existing), replay: true };
        }
        if (Object.keys(state().asks).length >= 4096) refuse('FLEET_ASK_CAPACITY', 'This retained tree has reached its ask history capacity; start a new tree to preserve this history.');
        const next = commit(value => { value.asks[input.id] = { nodeId: node.nodeId, question: input.question, status: 'open', filedAt: now() }; });
        return { revision: next.revision, id: input.id, ...next.asks[input.id] };
      }
      assertRoot(sessionId);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== state().revision)
        refuse('FLEET_CONTROL_STALE_REVISION', 'Read the latest control revision before changing it.');
      if (action === 'resources') {
        const policy = require('./fleet-v2-resources').validatePolicy(input.policy);
        return commit(value => { value.resources = policy; });
      }
      if (action === 'resource-advice') {
        if (!resources) refuse('FLEET_RESOURCE_GATE_UNAVAILABLE', 'This host has no native resource gate.');
        const result = resources.advise({ id: input.id, provider: input.provider, decision: input.decision, launches: input.launches, expiresAtMs: input.expiresAtMs, reason: input.reason });
        const next = commit(value => { value.resourceAdvice = { id: input.id, provider: input.provider, decision: input.decision, at: now() }; });
        return { revision: next.revision, result };
      }
      if (['pause', 'stop', 'resume', 'remove'].includes(action)) {
        identifier(input.nodeId);
        // Lifecycle is awaited: a pause receipt means the owned session is quiet.
        if (action === 'resume' && state().tasks[input.nodeId]?.status === 'completed')
          refuse('FLEET_TASK_COMPLETED', 'Assign the next durable task before resuming this completed assignment.');
        const result = await command({ action: `${action}-node`, nodeId: input.nodeId, parentSessionId: rootSessionId });
        const next = commit(value => {
          value.lifecycle = { nodeId: input.nodeId, action, at: now() };
          if (action === 'remove' && value.tasks[input.nodeId]) value.tasks[input.nodeId].status = 'removed';
        });
        return { revision: next.revision, result };
      }
      if (action === 'task') {
        identifier(input.nodeId); text(input.text, 'Task');
        const node = document.nodes.find(node => node.nodeId === input.nodeId);
        if (!node) refuse('FLEET_CONTROL_NODE_UNKNOWN', 'This task needs an existing tree worker.');
        if (node.state === 'running' || node.state === 'starting') refuse('FLEET_TASK_PAUSE_REQUIRED', 'Pause this worker before editing its assignment.');
        return commit(value => { value.tasks[input.nodeId] = { text: input.text, taskRevision: (value.tasks[input.nodeId]?.taskRevision || 1) + (input.newTask === true || value.tasks[input.nodeId]?.status === 'completed' ? 1 : 0), status: 'assigned', editedAt: now() }; });
      }
      if (action === 'rule') {
        identifier(input.id); text(input.text, 'Rule', 4000);
        if (document.nodes.some(node => ['running', 'starting'].includes(node.state)))
          refuse('FLEET_RULE_PAUSE_REQUIRED', 'Pause active workers before editing shared rules.');
        return commit(value => { value.rules[input.id] = { text: input.text, active: input.active !== false, editedAt: now() }; });
      }
      if (action === 'archive-ask') {
        identifier(input.id);
        const ask = state().asks[input.id];
        if (!ask) refuse('FLEET_ASK_UNKNOWN', 'There is no retained ask with that id.');
        const node = document.nodes.find(node => node.nodeId === ask.nodeId);
        if (node && ['running', 'starting'].includes(node.state)) await command({ action: 'pause-node', nodeId: node.nodeId, parentSessionId: rootSessionId });
        return commit(value => { value.asks[input.id].status = 'archived'; value.asks[input.id].archivedAt = now(); });
      }
      if (action === 'answer') {
        identifier(input.id); text(input.answer, 'Answer', 4000);
        const ask = state().asks[input.id];
        if (!ask) refuse('FLEET_ASK_UNKNOWN', 'There is no retained ask with that id.');
        if (Object.hasOwn(ask, 'answer')) {
          if (ask.answer !== input.answer) refuse('FLEET_ASK_ALREADY_ANSWERED', 'The ask already has a different answer.');
          return { revision: state().revision, replay: true, ...clone(ask) };
        }
        const node = document.nodes.find(node => node.nodeId === ask.nodeId);
        if (node && ['running', 'starting'].includes(node.state)) await command({ action: 'pause-node', nodeId: node.nodeId, parentSessionId: rootSessionId });
        return commit(value => { Object.assign(value.asks[input.id], { answer: input.answer, status: 'answered', answeredAt: now() }); });
      }
      if (action === 'settings' || action === 'import-settings') {
        if (!settings) refuse('FLEET_SETTINGS_UNAVAILABLE', 'This host has no settings writer.');
        if (document.nodes.some(node => ['running', 'starting'].includes(node.state)))
          refuse('FLEET_SETTINGS_PAUSE_REQUIRED', 'Pause workers before changing shared orchestration settings.');
        const result = settings(input.changes, { import: action === 'import-settings' });
        const next = commit(value => { value.settingsChangedAt = now(); if (result.resources) value.resources = result.resources; value.policies = { ...(value.policies || {}), ...(result.policies || {}) }; });
        return { revision: next.revision, result };
      }
      refuse('FLEET_CONTROL_ACTION_INVALID', 'Unknown Fleet control action.');
    });
  }
  function ensureTask(nodeId, brief) {
    identifier(nodeId); text(brief, 'Task');
    if (!state().tasks[nodeId]) commit(value => { value.tasks[nodeId] = { text: brief, taskRevision: 1, status: 'assigned', editedAt: now() }; });
  }
  return Object.freeze({ request, assignment, ensureTask, assertRoot });
}
module.exports = { createFleetControl };
