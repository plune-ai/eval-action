// A tiny MCP server for the smoke jobs of the MCP action, no dependencies.
//
//   node server.mjs <clean|broken|empty> [--log <file>] [--http <port>]
//
// clean   one read-only tool and one that changes state; answers initialize, ping, tools/list and
//         tools/call (of the read-only tool only).
// broken  breaks the specification: a tool whose closed schema (additionalProperties: false) lists
//         in `required` a property it does not define, so no call can satisfy it,
//         and a declared `prompts` capability whose list answers with an error.
// empty   declares tools and lists none: nothing to measure.
//
// --log   appends one JSON line per request it receives ({"method", "tool"}), the journal the
//         smoke jobs read: how many times a command connected, which tools were called, and that
//         nothing arrived at all.
// --http  serves Streamable HTTP at http://127.0.0.1:<port>/mcp (JSON answers, no SSE) instead of
//         stdio. With FIXTURE_TOKEN set, a POST without `Authorization: <FIXTURE_TOKEN>` gets 401.

import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const logFile = opt('--log');
const port = opt('--http');
if (!['clean', 'broken', 'empty'].includes(mode)) {
  console.error('usage: node server.mjs <clean|broken|empty> [--log <file>] [--http <port>]');
  process.exit(2);
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false };
const status = {
  name: 'get_status',
  description:
    'Returns the fixed status text of this test server. Use it to see that the server answers; it reads nothing and changes nothing.',
  inputSchema: noArgs,
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const reset = {
  name: 'reset_counter',
  description:
    'Sets the counter of this test server back to zero. Use it only to start over; unlike get_status it changes state.',
  inputSchema: noArgs,
  annotations: { readOnlyHint: false },
};
const tools = {
  clean: [status, reset],
  broken: [{ ...status, inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: ['missing'] } }],
  empty: [],
}[mode];

function answer(msg) {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ method: msg.method, tool: msg.params?.name }) + '\n');
  if (msg.id === undefined) return undefined; // a notification
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: msg.params?.protocolVersion,
        capabilities: mode === 'broken' ? { tools: {}, prompts: {} } : { tools: {} },
        serverInfo: { name: 'plune-smoke-fixture', version: '1.0.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools });
    case 'tools/call':
      return msg.params?.name === 'get_status'
        ? ok({ content: [{ type: 'text', text: 'ok' }] })
        : fail(-32602, `unknown tool ${msg.params?.name}`);
    case 'prompts/list':
      return fail(-32603, 'prompts/list is broken on purpose');
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

if (port) {
  http
    .createServer((req, res) => {
      if (req.method !== 'POST') return res.writeHead(405).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msgs = [].concat(JSON.parse(body));
        // Journal first: "no request arrived" must hold for a refused one too.
        if (process.env.FIXTURE_TOKEN && req.headers.authorization !== process.env.FIXTURE_TOKEN) {
          if (logFile) fs.appendFileSync(logFile, JSON.stringify({ method: msgs[0]?.method, refused: true }) + '\n');
          return res.writeHead(401).end();
        }
        const out = msgs.map(answer).filter(Boolean);
        if (out.length === 0) return res.writeHead(202).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
      });
    })
    .listen(Number(port), '127.0.0.1');
} else {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    const reply = answer(JSON.parse(line));
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
}
