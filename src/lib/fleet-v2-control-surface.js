'use strict';
const ACTIONS = Object.freeze(['read', 'ask', 'progress', 'complete']);
const FIELDS = new Set(['action', 'id', 'text', 'question', 'approvalToken']);
function workerSchema(schema) {
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => FIELDS.has(name)).map(([name, property]) =>
    [name, name === 'action' ? { ...property, enum: ACTIONS } : property])) };
}
function workerEntry(entry) {
  return Object.freeze({ ...entry,
    description: 'Read your durable assignment/asks, file a stable-id ask, or report progress/completion on your own current task. Lifecycle, task/rule edits, ask answers and settings belong to the orchestrator.',
    inputSchema: workerSchema(entry.inputSchema), baseInputSchema: workerSchema(entry.baseInputSchema) });
}
module.exports = { workerEntry };
