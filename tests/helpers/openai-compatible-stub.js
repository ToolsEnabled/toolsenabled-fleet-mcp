#!/usr/bin/env node
'use strict';

// A tiny OpenAI-compatible model server that always gives the same answer.
//
// Routes: GET /v1/models, POST /v1/chat/completions (plain or streamed) and
// POST /v1/responses (plain or streamed as server-sent events, the shape Codex
// reads). Every request is recorded with whether its Authorization header
// carried the expected key, carried an unresolved OpenShell placeholder, or
// carried nothing. The key itself is never recorded.
//
// Tests start it in process with startStub(). For a live check it also runs as
// a command, printing one JSON line per request:
//
//   STUB_EXPECTED_KEY=<made-up key> node tests/helpers/openai-compatible-stub.js \
//     --host 127.0.0.1 --port 18431 [--reply TEXT] [--model ID] [--prefix /v1]

const http = require('node:http');

const DEFAULT_REPLY = 'stub model says hello';
const DEFAULT_MODEL = 'stub-model';
const PLACEHOLDER_MARK = 'openshell:resolve';
const MAX_BODY = 1024 * 1024;

function classifyAuthorization(header, expectedKey, expectedPlaceholder = null) {
  if (!header) return 'none';
  const value = String(header);
  if (expectedPlaceholder && value === `Bearer ${expectedPlaceholder}`) return 'expected-placeholder';
  if (value.includes(PLACEHOLDER_MARK)) return 'placeholder';
  if (expectedKey && value === `Bearer ${expectedKey}`) return 'expected-key';
  return 'other';
}

function sse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  for (const event of events) {
    const type = event.type || null;
    response.write(`${type ? `event: ${type}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function responsesEvents(reply, model, toolCall = null) {
  const responseId = 'resp_stub_1';
  const itemId = 'msg_stub_1';
  const message = { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] };
  const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
  if (toolCall) {
    const call = { type: 'function_call', id: 'call_stub_1', status: 'completed',
      call_id: 'call_stub_1', name: toolCall.name, namespace: toolCall.namespace,
      arguments: JSON.stringify(toolCall.arguments || {}) };
    return [
      { type: 'response.created', response: { id: responseId, model, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...call, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: call.id, output_index: 0, delta: call.arguments },
      { type: 'response.function_call_arguments.done', item_id: call.id, output_index: 0, arguments: call.arguments },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response: { id: responseId, model, status: 'completed', output: [call], usage } }
    ];
  }
  return [
    { type: 'response.created', response: { id: responseId, model, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: reply },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: responseId, model, status: 'completed', output: [message], usage } }
  ];
}

/**
 * Start the stub. Resolves `{ url, port, requests, close }`; `requests` is the
 * live list of recorded requests.
 */
function startStub({ host = '127.0.0.1', port = 0, reply = DEFAULT_REPLY, model = DEFAULT_MODEL, prefix = '/v1', expectedKey = null,
  expectedPlaceholder = null, onRequest = null, callOnce = null, respond = null } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      let body = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      const url = new URL(request.url, 'http://stub.invalid');
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
      const record = {
        at: new Date().toISOString(),
        method: request.method,
        path: url.pathname,
        authorization: classifyAuthorization(request.headers.authorization, expectedKey, expectedPlaceholder),
        model: body && typeof body.model === 'string' ? body.model : null,
        stream: Boolean(body && body.stream),
        tools: Array.isArray(body && body.tools) ? body.tools.map((tool) => tool.name || tool.type).filter(Boolean) : [],
        offeredFunctions: Array.isArray(body && body.tools) ? body.tools.flatMap((tool) =>
          tool.type === 'namespace' && Array.isArray(tool.tools)
            ? tool.tools.map((child) => `${tool.name}__${child.name}`)
            : tool.type === 'function' && tool.name ? [tool.name] : []) : [],
        functionOutputSeen: Array.isArray(body && body.input) && body.input.some((item) => item.type === 'function_call_output')
      };
      requests.push(record);
      if (typeof onRequest === 'function') onRequest(record);
      // A synthetic credential-resolving proxy accepts only its generated
      // handle. A structurally valid but synthesized literal must fail too.
      // Neither the received header nor the expected handle is recorded.
      if (expectedPlaceholder !== null && record.authorization !== 'expected-placeholder') {
        return json(response, 500, { error: 'credential_unavailable', message: 'Credential placeholder could not be resolved' });
      }
      // Test-only custom protocol replies. Header values are never exposed or
      // recorded; tests can assert the bounded authorization classification.
      if (typeof respond === 'function') {
        response.setHeader('content-type', 'application/json');
        Promise.resolve().then(() => respond({ ...record, body }, response, requests.length))
          .catch(() => { if (!response.destroyed) response.destroy(); });
        return;
      }

      if (request.method === 'GET' && route === '/models') {
        return json(response, 200, { object: 'list', data: [{ id: model, object: 'model', owned_by: 'stub' }] });
      }
      if (request.method === 'POST' && route === '/chat/completions') {
        if (body && body.stream) {
          return sse(response, [
            { id: 'chatcmpl-stub', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] },
            { id: 'chatcmpl-stub', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            '[DONE]'
          ].map((event) => (typeof event === 'string' ? event : { ...event, type: undefined })));
        }
        return json(response, 200, {
          id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
      }
      if (request.method === 'POST' && route === '/responses') {
        const events = responsesEvents(reply, model, callOnce && !record.functionOutputSeen ? callOnce : null);
        if (body && body.stream) return sse(response, events);
        return json(response, 200, { ...events[events.length - 1].response, object: 'response', output_text: reply });
      }
      return json(response, 404, { error: { message: `no route ${request.method} ${url.pathname}`, type: 'not_found' } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}${prefix}`,
        port: address.port,
        requests,
        close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); })
      });
    });
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--host', '--port', '--reply', '--model', '--prefix'].includes(flag) || value === undefined) {
      throw new Error(`Unknown or incomplete option ${flag}`);
    }
    options[flag.slice(2)] = flag === '--port' ? Number(value) : value;
    index += 1;
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  startStub({ ...options, expectedKey: process.env.STUB_EXPECTED_KEY || null, onRequest: (record) => process.stdout.write(`${JSON.stringify(record)}\n`) })
    .then((stub) => {
      process.stdout.write(`${JSON.stringify({ listening: stub.url })}\n`);
      const stop = () => stub.close().then(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    }, (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { DEFAULT_MODEL, DEFAULT_REPLY, classifyAuthorization, responsesEvents, startStub };
