'use strict';
const os = require('os');
function validOverrides(value) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  return value.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['kind', 'id', 'enabled'].includes(key))
      || !['agent', 'lane', 'host'].includes(row.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.id) || typeof row.enabled !== 'boolean') return false;
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function statusEnabled(global, overrides, identity) {
  if (typeof global !== 'boolean' || !validOverrides(overrides)) return false;
  for (const kind of ['agent', 'lane', 'host']) {
    const row = overrides.find(row => row.kind === kind && row.id === identity[kind]);
    if (row) return row.enabled;
  }
  return global;
}
const TOKEN_KEYS = new Set(['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens']);
function usageNumbers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (TOKEN_KEYS.has(key) && Number.isSafeInteger(value) && value >= 0) result[key] = value;
    else if (['total', 'last'].includes(key) && value && typeof value === 'object') {
      const nested = usageNumbers(value); if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}
function createObservability({ document, persist, read = id => require('./settings').loadSettings({ ids: [id] }).values[id],
  laneId, hostId = os.hostname(), now = () => new Date().toISOString(), machine = os } = {}) {
  let previousCpu = null;
  const enabled = () => { try { return read('metrics.local_history') === true; } catch { return false; } };
  function record(event) {
    if (!enabled() || !['started', 'closed', 'usage', 'turn_completed'].includes(event.type)) return;
    const row = { type: event.type, at: now() };
    for (const key of ['nodeId', 'sessionId', 'threadId', 'turnId', 'provider'])
      if (typeof event[key] === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(event[key])) row[key] = event[key];
    if (event.type === 'usage') { row.usage = usageNumbers(event.usage); if (!Object.keys(row.usage).length) return; }
    if (['completed', 'failed', 'interrupted', 'cancelled', 'stopped'].includes(event.status)) row.status = event.status;
    const before = document.fleetMetrics;
    const entries = Array.isArray(before?.entries) ? before.entries : [];
    // Numeric metadata is separate from the retained provider/session traces.
    document.fleetMetrics = { v: 1, entries: [...entries, row] };
    try { persist(document); } catch (error) { document.fleetMetrics = before; throw error; }
  }
  function history({ offset = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw Object.assign(new Error('Use a nonnegative offset and a limit from 1 to 1000.'), { code: 'FLEET_METRICS_PAGE_INVALID' });
    if (!enabled()) return { enabled: false, entries: [], total: 0, retained: true };
    const entries = document.fleetMetrics?.entries || [];
    return { enabled: true, total: entries.length, entries: structuredClone(entries.slice(offset, offset + limit)) };
  }
  function introduction(node) {
    let global, overrides;
    try { global = read('agent.status_injection'); overrides = read('agent.status_injection_overrides'); } catch { return ''; }
    if (!statusEnabled(global, overrides, { agent: node.nodeId, lane: laneId, host: hostId })) return '';
    const cpu = machine.cpus().reduce((out, row) => {
      out.idle += row.times.idle; out.total += Object.values(row.times).reduce((sum, value) => sum + value, 0); return out;
    }, { idle: 0, total: 0 });
    const delta = previousCpu && cpu.total - previousCpu.total;
    const percentage = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previousCpu.idle) / delta))) : null;
    previousCpu = cpu;
    return ['Machine status (opted in; unknown measurements are not inferred):',
      `CPU: ${percentage === null ? 'unknown (first sample)' : percentage.toFixed(1) + '%'}. Memory free/total: ${machine.freemem()}/${machine.totalmem()} bytes.`,
      'State health: unknown. Audit health: unknown. Owner-request capture backlog: unknown. Usage/quota availability: unknown.'].join('\n');
  }
  return Object.freeze({ record, history, introduction });
}
module.exports = { createObservability, statusEnabled, validOverrides, usageNumbers };
