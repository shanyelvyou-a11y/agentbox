// MCP + docs acceptance harness — drives src/index.js directly with in-memory KV.
// Not deployed; run: node tests/mcp-harness.mjs
import worker from '../src/index.js';

class KVStub {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async list({ prefix = '', limit = 1000 } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

const results = [];
function check(name, cond, extra = '') {
  results.push([name, !!cond, extra]);
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

// Prevent any accidental real network (CF rule creation is skipped without a token anyway).
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

function mkEnv(extra = {}) {
  return { KV: new KVStub(), DOMAIN: 'mail.example.com', ADMIN_TOKEN: 'test-admin', ...extra };
}
const ctx = () => { let p; return { waitUntil(x) { p = x; }, done: () => p }; };

function mcpReq(payload, token) {
  return new Request('http://local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}
async function mcpCall(env, method, params, token, id = 1) {
  const res = await worker.fetch(mcpReq({ jsonrpc: '2.0', id, method, params }, token), env, ctx());
  const body = await res.json().catch(() => null);
  return { res, body };
}
async function toolCall(env, name, args, token) {
  const { res, body } = await mcpCall(env, 'tools/call', { name, arguments: args }, token);
  return { res, rpc: body, result: body && body.result };
}

const MIME = (to, code) => new TextEncoder().encode(
  `From: Sender <sender@example.com>\r\nTo: ${to}\r\nSubject: Your verification code\r\n` +
  `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
  `Your verification code is ${code}. Confirm here: https://example.com/confirm/abc\r\n`);
async function sendMail(env, to, code) {
  const c = ctx();
  await worker.email({ to, from: 'sender@example.com', raw: MIME(to, code), headers: new Headers() }, env, c);
  if (c.done()) await c.done();
}

/* ---- 1. initialize / ping / notifications ---- */
{
  const env = mkEnv();
  const init = await mcpCall(env, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  check('initialize 200 jsonrpc', init.res.status === 200 && init.body.jsonrpc === '2.0' && init.body.id === 1);
  check('initialize echoes client protocolVersion', init.body.result.protocolVersion === '2025-03-26');
  check('initialize capabilities + serverInfo', init.body.result.capabilities && 'tools' in init.body.result.capabilities
    && init.body.result.serverInfo.name === 'agent-mail' && init.body.result.serverInfo.title === 'AgentBox'
    && init.body.result.serverInfo.version === '0.3.0');
  const initDefault = await mcpCall(env, 'initialize', {});
  check('initialize defaults protocolVersion 2025-06-18', initDefault.body.result.protocolVersion === '2025-06-18');
  const ping = await mcpCall(env, 'ping', {});
  check('ping returns {}', ping.body.result && Object.keys(ping.body.result).length === 0);
  const notif = await worker.fetch(mcpReq({ jsonrpc: '2.0', method: 'notifications/initialized' }), env, ctx());
  const notifBody = await notif.text();
  check('notifications/initialized -> 202, no body', notif.status === 202 && notifBody === '');
  const notif2 = await worker.fetch(mcpReq({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), env, ctx());
  check('other notifications/* -> 202', notif2.status === 202);
}

/* ---- 2. tools/list ---- */
{
  const env = mkEnv();
  const { body } = await mcpCall(env, 'tools/list', {});
  const tools = body.result.tools;
  const names = tools.map((t) => t.name).sort();
  check('tools/list has exactly the 4 tools', JSON.stringify(names) === JSON.stringify(['create_inbox', 'get_message', 'list_messages', 'wait_for_message']), names.join(','));
  check('every tool has description with "use when" semantics',
    tools.every((t) => typeof t.description === 'string' && /use when/i.test(t.description)));
  check('every tool inputSchema marks required fields',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object' && Array.isArray(t.inputSchema.required) && t.inputSchema.required.length >= 1));
  const ci = tools.find((t) => t.name === 'create_inbox');
  check('create_inbox requires name only', JSON.stringify(ci.inputSchema.required) === '["name"]');
  const wf = tools.find((t) => t.name === 'wait_for_message');
  check('wait_for_message schema has timeout_seconds + after',
    !!wf.inputSchema.properties.timeout_seconds && !!wf.inputSchema.properties.after);
}

/* ---- 3. create_inbox via MCP, then REST reads it; auth mapping ---- */
const mainEnv = mkEnv();
let mcpBox;
{
  const noAdmin = await toolCall(mainEnv, 'create_inbox', { name: 'noadmin' }, null);
  check('create_inbox without admin token -> isError status 401',
    noAdmin.result.isError === true && JSON.parse(noAdmin.result.content[0].text).status === 401);
  check('failed create stored nothing', (await mainEnv.KV.get('inbox|noadmin@mail.example.com')) === null);

  const created = await toolCall(mainEnv, 'create_inbox', { name: 'mcpbox' }, 'test-admin');
  check('create_inbox via MCP succeeds (isError false)', created.result.isError === false);
  mcpBox = created.result.structuredContent;
  check('create_inbox result text JSON == structuredContent',
    JSON.parse(created.result.content[0].text).address === mcpBox.address);
  check('create_inbox returns address + one-time secrets',
    mcpBox.address === 'mcpbox@mail.example.com' && typeof mcpBox.api_key === 'string' && typeof mcpBox.webhook_secret === 'string');

  const rest = await worker.fetch(new Request('http://local/inboxes/mcpbox@mail.example.com/messages', {
    headers: { authorization: 'Bearer ' + mcpBox.api_key },
  }), mainEnv, ctx());
  check('REST can read the MCP-created inbox (200)', rest.status === 200);

  const dup = await toolCall(mainEnv, 'create_inbox', { name: 'mcpbox' }, 'test-admin');
  check('duplicate create_inbox -> isError status 409',
    dup.result.isError === true && JSON.parse(dup.result.content[0].text).status === 409);
}

/* ---- 4. list/get auth semantics + codes ---- */
{
  const noKey = await toolCall(mainEnv, 'list_messages', { address: mcpBox.address }, null);
  const noKeyErr = JSON.parse(noKey.result.content[0].text);
  check('list_messages without key -> isError {error,status:401}',
    noKey.result.isError === true && noKeyErr.status === 401 && typeof noKeyErr.error === 'string');

  const other = await toolCall(mainEnv, 'create_inbox', { name: 'otherbox' }, 'test-admin');
  const cross = await toolCall(mainEnv, 'list_messages', { address: mcpBox.address }, other.result.structuredContent.api_key);
  check('list_messages with another inbox key -> isError status 403',
    cross.result.isError === true && JSON.parse(cross.result.content[0].text).status === 403);

  const ghost = await toolCall(mainEnv, 'list_messages', { address: 'ghost@mail.example.com' }, mcpBox.api_key);
  // authedInbox semantics (same as REST): a real key belonging to a DIFFERENT
  // inbox maps to 403 even when the target inbox does not exist; 404 only
  // happens for a key that is valid nowhere (covered by REST harness tests).
  check('list_messages for unknown inbox with another inbox key -> isError status 403 (authedInbox semantics)',
    ghost.result.isError === true && JSON.parse(ghost.result.content[0].text).status === 403);
  const ghostNoKey = await toolCall(mainEnv, 'list_messages', { address: 'ghost@mail.example.com' }, 'am_validnowhere');
  check('list_messages for unknown inbox with valid-nowhere key -> isError status 404',
    ghostNoKey.result.isError === true && JSON.parse(ghostNoKey.result.content[0].text).status === 404);

  await sendMail(mainEnv, mcpBox.address, '654321');
  const list = await toolCall(mainEnv, 'list_messages', { address: mcpBox.address, limit: 5 }, mcpBox.api_key);
  check('list_messages ok, code extracted',
    list.result.isError === false && list.result.structuredContent.count === 1
    && list.result.structuredContent.messages[0].codes.some((c) => c.code === '654321'));
  const mid = list.result.structuredContent.messages[0].id;
  const got = await toolCall(mainEnv, 'get_message', { address: mcpBox.address, message_id: mid }, mcpBox.api_key);
  check('get_message returns full message', got.result.isError === false && got.result.structuredContent.id === mid
    && /654321/.test(got.result.structuredContent.text || ''));
  const missing = await toolCall(mainEnv, 'get_message', { address: mcpBox.address, message_id: 'nope' }, mcpBox.api_key);
  check('get_message missing id -> isError status 404',
    missing.result.isError === true && JSON.parse(missing.result.content[0].text).status === 404);
}

/* ---- 5. wait_for_message after-cursor semantics ---- */
{
  const bx = (await toolCall(mainEnv, 'create_inbox', { name: 'waitbox' }, 'test-admin')).result.structuredContent;
  await sendMail(mainEnv, bx.address, '200001');
  await sendMail(mainEnv, bx.address, '200002');
  const list = await toolCall(mainEnv, 'list_messages', { address: bx.address }, bx.api_key);
  const idsAsc = list.result.structuredContent.messages.map((m) => m.id).reverse();
  const w = await toolCall(mainEnv, 'wait_for_message', { address: bx.address, timeout_seconds: 10, after: idsAsc[0] }, bx.api_key);
  check('wait_for_message after=first returns only the second message',
    w.result.isError === false && w.result.structuredContent.timed_out === false
    && w.result.structuredContent.messages.length === 1 && w.result.structuredContent.messages[0].id === idsAsc[1]);
  const w2 = await toolCall(mainEnv, 'wait_for_message', { address: bx.address, timeout_seconds: 2, after: idsAsc[1] }, bx.api_key);
  check('wait_for_message after=last times out (normal, not error)',
    w2.result.isError === false && w2.result.structuredContent.timed_out === true && w2.result.structuredContent.messages.length === 0);
}

/* ---- 6. protocol errors ---- */
{
  const env = mkEnv();
  const unknown = await mcpCall(env, 'resources/list', {});
  check('unknown method -> JSON-RPC -32601', unknown.body.error && unknown.body.error.code === -32601);
  const unknownTool = await toolCall(env, 'delete_inbox', {}, 'test-admin');
  check('unknown tool -> JSON-RPC -32602', unknownTool.rpc.error && unknownTool.rpc.error.code === -32602);
  const parse = await worker.fetch(mcpReq('this is not json'), env, ctx());
  const parseBody = await parse.json();
  check('non-JSON body -> -32700 parse error', parseBody.error && parseBody.error.code === -32700);
  const invalid = await worker.fetch(mcpReq({ id: 9, method: 'ping' }), env, ctx());
  const invalidBody = await invalid.json();
  check('missing jsonrpc field -> -32600', invalidBody.error && invalidBody.error.code === -32600 && invalidBody.id === 9);
  const get = await worker.fetch(new Request('http://local/mcp'), env, ctx());
  check('GET /mcp -> 405', get.status === 405);
}

/* ---- 7. docs routes + homepage links ---- */
{
  const env = mkEnv();
  const im = await worker.fetch(new Request('http://local/install.md'), env, ctx());
  const imText = await im.text();
  check('/install.md 200 text/markdown', im.status === 200 && /text\/markdown/.test(im.headers.get('content-type') || ''));
  check('/install.md contains quickstart + mcp config + troubleshooting',
    imText.includes('## Quickstart') && imText.includes('agentbox.example.com/mcp')
    && imText.includes('Troubleshooting') && imText.includes('rule_status') && imText.includes('200 rules per zone'));
  const ll = await worker.fetch(new Request('http://local/llms.txt'), env, ctx());
  const llText = await ll.text();
  check('/llms.txt 200 text/plain', ll.status === 200 && /text\/plain/.test(ll.headers.get('content-type') || ''));
  check('/llms.txt contains summary + install link',
    llText.includes('# AgentBox') && llText.includes('/install.md') && llText.includes('wait_for_message'));
  const home = await worker.fetch(new Request('http://local/'), env, ctx());
  const homeText = await home.text();
  check('homepage links install.md, llms.txt and /mcp',
    homeText.includes('/install.md') && homeText.includes('/llms.txt') && homeText.includes('/mcp'));
}

globalThis.fetch = realFetch;
const failed = results.filter((r) => !r[1]);
console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' passed ==');
process.exit(failed.length ? 1 : 0);
