// AgentBox — MVP (self-use). Email inboxes for AI agents, on Cloudflare Workers + KV.
// AgentBox — see README.md and install.md in this repository.
// Storage layout (KV):
//   inbox|<addr>  -> inbox record JSON (key_hash only, never the plain key)
//   idx|<addr>    -> JSON array of message ids, oldest first
//   msg|<addr>|<id> -> message record JSON
//   sink|log      -> last 50 webhook test callbacks (via /sink)
// Webhook signature (v2): per-inbox webhook_secret (stored server-side, rotatable,
// returned once at inbox creation). sig = HMAC-SHA256(webhook_secret, timestamp + "." + body),
// headers: X-Agent-Mail-Signature: sha256=<hex>, X-Agent-Mail-Timestamp, X-Agent-Mail-Event-Id.
// The API key is hash-only and used for auth only — it never signs anything.
// Legacy inboxes without webhook_secret get one lazily on first webhook send.

import PostalMime from 'postal-mime';
import { INSTALL_MD, LLMS_TXT } from './docs.js';

const DAILY_LIMIT = 500;

/* ---------- helpers ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msgStr));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function todayUTC() { return new Date().toISOString().slice(0, 10); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stripHtml(html) {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

/* ---------- extraction ---------- */

const CONFIRM_RE = /(confirm|verif|activat|validat|approve|验证|确认|激活|完成注册)/i;

function extractLinks(text, html) {
  const byUrl = new Map();
  if (html) {
    const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[1].trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const anchor = stripHtml(m[2]);
      if (!byUrl.has(url)) byUrl.set(url, { url, anchor_text: anchor.slice(0, 80) });
    }
  }
  const bare = (text || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  for (const raw of bare) {
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (!byUrl.has(url)) byUrl.set(url, { url, anchor_text: '' });
  }
  const links = [...byUrl.values()];
  const confirm_links = links.filter((l) => CONFIRM_RE.test(l.url) || CONFIRM_RE.test(l.anchor_text)).map((l) => l.url);
  return { links: links.map((l) => l.url), confirm_links };
}

function extractCodes(text) {
  const found = new Map(); // code -> best {code, confidence, context}
  const add = (code, confidence, ctx) => {
    if (!code) return;
    code = String(code).trim();
    if (code.length < 4 || code.length > 8) return;
    if (!/\d/.test(code)) return; // a code always contains a digit; kills word false-positives like "expires"
    const prev = found.get(code);
    const rank = { high: 3, medium: 2, low: 1 };
    if (!prev || rank[confidence] > rank[prev.confidence]) {
      found.set(code, { code, confidence, context: (ctx || '').replace(/\s+/g, ' ').slice(0, 60) });
    }
  };
  const KW = '(?:code|验证码|校验码|动态码|otp|passcode|pin|verification|one[- ]?time|security code)';
  let m;
  // Gap between keyword and code may contain words like "is" / "是" — allow up to 24
  // non-sentence-boundary chars (lazy), and require the captured token to be code-like.
  const re1 = new RegExp(KW + '[^.\\n]{0,24}?([0-9]{4,8}|[A-Za-z0-9]{5,8})', 'gi');
  while ((m = re1.exec(text)) !== null) add(m[1], 'high', text.slice(Math.max(0, m.index - 10), m.index + m[0].length + 4));
  const re2 = new RegExp('([0-9]{4,8})\\s*(?:is your|是你的|为您的?)?\\s*' + KW, 'gi');
  while ((m = re2.exec(text)) !== null) add(m[1], 'high', text.slice(Math.max(0, m.index - 10), m.index + m[0].length + 14));
  const re3 = /\b\d{6}\b/g;
  while ((m = re3.exec(text)) !== null) add(m[0], 'medium', text.slice(Math.max(0, m.index - 20), m.index + 26));
  const re4 = /\b\d{5,8}\b/g;
  while ((m = re4.exec(text)) !== null) add(m[0], 'low', text.slice(Math.max(0, m.index - 20), m.index + 28));
  return [...found.values()];
}

/* ---------- KV store ---------- */

async function getInbox(env, addr) {
  const raw = await env.KV.get('inbox|' + addr);
  return raw ? JSON.parse(raw) : null;
}
async function putInbox(env, rec) {
  await env.KV.put('inbox|' + rec.address, JSON.stringify(rec));
}
async function getIdx(env, addr) {
  const raw = await env.KV.get('idx|' + addr);
  return raw ? JSON.parse(raw) : [];
}
async function getMsg(env, addr, id) {
  const raw = await env.KV.get('msg|' + addr + '|' + id);
  return raw ? JSON.parse(raw) : null;
}
async function inboxCount(env) {
  const list = await env.KV.list({ prefix: 'inbox|', limit: 1000 });
  return list.keys.length;
}

function summarize(msg) {
  return {
    id: msg.id,
    from: msg.from,
    subject: msg.subject,
    received_at: msg.received_at,
    snippet: msg.snippet,
    codes: msg.codes,
    confirm_links: msg.confirm_links,
    links: msg.links,
    attachments: msg.attachments,
  };
}

/* ---------- auth ---------- */

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return req.headers.get('x-api-key') || null;
}

function isAdmin(req, env) {
  const t = bearer(req);
  return !!t && !!env.ADMIN_TOKEN && t === env.ADMIN_TOKEN;
}

// Returns {inbox} or {error: Response}
// Semantics (per SPEC acceptance #4): no key / key that belongs to no inbox -> 401;
// a real key of a DIFFERENT inbox -> 403; target inbox missing (key valid nowhere) -> 404 handled by 401 first.
async function authedInbox(req, env, addr) {
  const key = bearer(req);
  if (!key) return { error: json({ error: 'missing api key' }, 401) };
  const hash = await sha256hex(key);
  const inbox = await getInbox(env, addr);
  if (inbox && inbox.key_hash === hash) return { inbox };
  // Key does not open the target inbox: does it belong to another inbox?
  const list = await env.KV.list({ prefix: 'inbox|', limit: 1000 });
  for (const k of list.keys) {
    const otherAddr = k.name.slice(6);
    if (otherAddr === addr) continue;
    const other = await getInbox(env, otherAddr);
    if (other && other.key_hash === hash) {
      return { error: json({ error: 'api key belongs to a different inbox' }, 403) };
    }
  }
  if (!inbox) return { error: json({ error: 'inbox not found' }, 404) };
  return { error: json({ error: 'invalid api key' }, 401) };
}

/* ---------- Cloudflare Email Routing rule ---------- */

async function cfCreateRule(env, addr, name) {
  if (!env.CF_API_TOKEN) return { status: 'skipped', detail: 'CF_API_TOKEN not set' };
  const url = 'https://api.cloudflare.com/client/v4/zones/' + env.CF_ZONE_ID + '/email/routing/rules';
  const payload = {
    name: 'agent-mail-box-' + name,
    matchers: [{ type: 'literal', field: 'to', value: addr }],
    actions: [{ type: 'worker', value: ['agent-mail'] }],
    enabled: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.CF_API_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    return { status: 'failed', detail: JSON.stringify(data.errors || data).slice(0, 300) };
  }
  // Read back to verify.
  const listRes = await fetch(url + '?per_page=50', {
    headers: { authorization: 'Bearer ' + env.CF_API_TOKEN },
  });
  const listData = await listRes.json().catch(() => ({}));
  const rules = (listData && listData.result) || [];
  const mine = rules.find((r) => (r.matchers || []).some((mm) => mm.type === 'literal' && mm.value === addr)
    && (r.actions || []).some((a) => a.type === 'worker' && (a.value || []).includes('agent-mail')));
  if (mine && mine.enabled) return { status: 'verified', rule_id: mine.id };
  if (mine) return { status: 'created_not_enabled', rule_id: mine.id };
  return { status: 'created_unverified', rule_id: data.result && data.result.id };
}

/* ---------- webhook ---------- */

// Lazily backfill webhook_secret for legacy (v1) inboxes so they keep working.
async function ensureWebhookSecret(env, inbox) {
  if (inbox.webhook_secret) return inbox.webhook_secret;
  inbox.webhook_secret = randHex(32);
  await putInbox(env, inbox);
  console.log('[agent-mail] backfilled webhook_secret inbox=' + inbox.address);
  return inbox.webhook_secret;
}

async function fireWebhook(env, inbox, msg) {
  const secret = await ensureWebhookSecret(env, inbox);
  const eventId = msg.event_id || ('evt_' + randHex(8));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    event: 'message.received',
    event_id: eventId,
    timestamp: Number(timestamp),
    inbox: inbox.address,
    message: summarize(msg),
  });
  const sig = await hmacHex(secret, timestamp + '.' + payload);
  let last = 'no-attempt';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(inbox.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agent-mail-signature': 'sha256=' + sig,
          'x-agent-mail-timestamp': timestamp,
          'x-agent-mail-event-id': eventId,
          'x-agent-mail-inbox': inbox.address,
        },
        body: payload,
      });
      last = 'http_' + res.status;
      console.log('[agent-mail] webhook attempt ' + attempt + ' inbox=' + inbox.address + ' msg=' + msg.id + ' -> ' + last);
      if (res.ok) return { status: last, attempts: attempt };
    } catch (e) {
      last = 'error:' + String(e && e.message || e).slice(0, 80);
      console.log('[agent-mail] webhook attempt ' + attempt + ' inbox=' + inbox.address + ' msg=' + msg.id + ' -> ' + last);
    }
    if (attempt < 3) await sleep(attempt === 1 ? 1000 : 3000);
  }
  return { status: last, attempts: 3 };
}

/* ---------- shared cores (REST + MCP use the exact same logic) ---------- */

// Returns {status, body}; REST renders it 1:1, MCP maps status>=400 to a tool error.
async function createInboxCore(env, domain, body) {
  const name = String((body && body.name) || '').toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,30}$/.test(name)) {
    return { status: 400, body: { error: 'name must match ^[a-z0-9][a-z0-9_-]{1,30}$' } };
  }
  const addr = name + '@' + domain;
  if (await getInbox(env, addr)) return { status: 409, body: { error: 'inbox already exists' } };
  // Capacity soft cap (addresses axis): refuse before creating anything.
  const maxInboxes = parseInt(env.MAX_INBOXES || '200', 10) || 200;
  const current = await inboxCount(env);
  if (current >= maxInboxes) {
    return { status: 429, body: { error: 'inbox capacity reached', limit: maxInboxes, current } };
  }
  const apiKey = 'am_' + randHex(24);
  const rec = {
    address: addr,
    name,
    key_hash: await sha256hex(apiKey),
    webhook_secret: randHex(32),
    webhook_url: body && body.webhook_url ? String(body.webhook_url) : null,
    created_at: new Date().toISOString(),
    day: todayUTC(),
    day_count: 0,
    dropped_count: 0,
    rule_status: 'pending',
  };
  await putInbox(env, rec);
  const rule = await cfCreateRule(env, addr, name);
  rec.rule_status = rule.status;
  if (rule.rule_id) rec.rule_id = rule.rule_id;
  if (rule.detail) rec.rule_detail = rule.detail;
  await putInbox(env, rec);
  // api_key and webhook_secret are each returned exactly once: here.
  return { status: 201, body: { address: addr, api_key: apiKey, webhook_secret: rec.webhook_secret, webhook_url: rec.webhook_url, rule_status: rule.status, rule_id: rule.rule_id || null } };
}

async function listMessagesCore(env, addr, limit) {
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const idx = await getIdx(env, addr);
  const ids = idx.slice(-lim).reverse();
  const out = [];
  for (const id of ids) {
    const msg = await getMsg(env, addr, id);
    if (msg) out.push(summarize(msg));
  }
  return { inbox: addr, count: out.length, messages: out };
}

// Cursor semantics: with `after`, everything up to and including that message id
// counts as seen, so only messages after the cursor are returned (including ones
// that arrived before this call). Unknown id falls back to baseline = all current
// messages seen. Without `after`, baseline is the moment of the call.
async function waitMessagesCore(env, addr, timeoutSec, after) {
  const startIdx = await getIdx(env, addr);
  let seen;
  if (after) {
    const pos = startIdx.indexOf(after);
    seen = new Set(pos >= 0 ? startIdx.slice(0, pos + 1) : startIdx);
  } else {
    seen = new Set(startIdx);
  }
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const idx = await getIdx(env, addr);
    const fresh = idx.filter((id) => !seen.has(id));
    if (fresh.length) {
      const out = [];
      for (const id of fresh) {
        const msg = await getMsg(env, addr, id);
        if (msg) out.push(summarize(msg));
      }
      if (out.length) return { inbox: addr, timed_out: false, messages: out };
    }
  }
  return { inbox: addr, timed_out: true, messages: [] };
}

/* ---------- MCP (stateless Streamable HTTP, single JSON response, no SSE) ---------- */

const MCP_TOOLS = [
  {
    name: 'create_inbox',
    description: 'Create a new email inbox for an AI agent on this AgentBox server. Use when an agent needs its own email address to receive verification codes, confirmation links, or notifications. Requires the operator ADMIN token in the Authorization: Bearer header of the MCP request (not an inbox key). Returns the address plus api_key and webhook_secret, each shown exactly once - save them immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Local part of the address (the part before @). Must match ^[a-z0-9][a-z0-9_-]{1,30}$ (lowercase letters, digits, underscore, dash).' },
        webhook_url: { type: 'string', description: 'Optional HTTPS URL that receives a signed POST for every new message (event message.received).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_messages',
    description: 'List recent messages in one inbox, newest first, including extracted verification codes, confirmation links, and links. Use when checking whether expected mail has arrived, or when looking for a verification code or confirmation link in recent mail. Requires that inbox\'s own API key in the Authorization: Bearer header of the MCP request.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Full inbox address, e.g. myagent@mail.example.com.' },
        limit: { type: 'integer', description: 'Maximum number of messages to return (default 50, max 200).', minimum: 1, maximum: 200 },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_message',
    description: 'Fetch the full text of a single message by id. Use when the list_messages summary or snippet is not enough and you need the complete body of one specific message. Requires that inbox\'s own API key in the Authorization: Bearer header of the MCP request.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Full inbox address that owns the message.' },
        message_id: { type: 'string', description: 'Message id as returned by list_messages or wait_for_message.' },
      },
      required: ['address', 'message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_message',
    description: 'Long-poll until a new message arrives in an inbox, or until the timeout elapses. Use when you just triggered an email (signup, password reset, magic link) and need to wait for it instead of polling list_messages. Pass `after` with the last message id you already consumed so only newer messages are returned; save the newest returned id as your next cursor. A result with timed_out=true is a normal outcome, not an error. Requires that inbox\'s own API key in the Authorization: Bearer header of the MCP request.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Full inbox address to wait on.' },
        timeout_seconds: { type: 'integer', description: 'How long to wait before returning timed_out (default 20, max 50).', minimum: 1, maximum: 50 },
        after: { type: 'string', description: 'Optional cursor: a message id you already consumed. Only messages after this id are returned.' },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
];

function rpcResult(id, result) {
  return json({ jsonrpc: '2.0', id, result });
}
function rpcError(id, code, message) {
  return json({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
}
function toolOk(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}
function toolErr(error, status, extra) {
  const obj = Object.assign({ error, status }, extra || {});
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError: true };
}

// Reuse REST auth semantics exactly: build a synthetic request carrying the
// caller's bearer token and run it through authedInbox, then map its HTTP
// status into the tool-error shape {error, status}.
async function mcpAuthedInbox(env, req, addr) {
  const key = bearer(req);
  const fake = new Request('http://local/mcp', { headers: key ? { authorization: 'Bearer ' + key } : {} });
  const auth = await authedInbox(fake, env, addr);
  if (!auth.error) return auth;
  const status = auth.error.status;
  let errText = 'auth error';
  try {
    const parsed = JSON.parse(await auth.error.text());
    if (parsed && parsed.error) errText = parsed.error;
  } catch { /* keep default */ }
  return { toolError: toolErr(errText, status) };
}

async function mcpCallTool(req, env, domain, name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'create_inbox') {
    if (!isAdmin(req, env)) return toolErr('admin token required', 401);
    const r = await createInboxCore(env, domain, a);
    if (r.status !== 201) return toolErr(r.body.error || 'create inbox failed', r.status, r.body.limit !== undefined ? { limit: r.body.limit, current: r.body.current } : null);
    return toolOk(r.body);
  }
  if (name === 'list_messages' || name === 'get_message' || name === 'wait_for_message') {
    const addr = String(a.address || '').toLowerCase().trim();
    if (!addr) return toolErr('address is required', 400);
    const auth = await mcpAuthedInbox(env, req, addr);
    if (auth.toolError) return auth.toolError;
    if (name === 'list_messages') {
      return toolOk(await listMessagesCore(env, addr, a.limit));
    }
    if (name === 'get_message') {
      const mid = String(a.message_id || '');
      if (!mid) return toolErr('message_id is required', 400);
      const msg = await getMsg(env, addr, mid);
      if (!msg) return toolErr('message not found', 404);
      return toolOk(msg);
    }
    // wait_for_message
    const t = parseInt(a.timeout_seconds, 10);
    const timeout = Math.min(Number.isFinite(t) && t > 0 ? t : 20, 50);
    return toolOk(await waitMessagesCore(env, addr, timeout, a.after ? String(a.after) : null));
  }
  return null; // unknown tool
}

async function handleMcp(req, env) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed: POST only' }), {
      status: 405,
      headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
    });
  }
  const domain = env.DOMAIN || 'mail.example.com';
  let body;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return rpcError(null, -32700, 'Parse error: body is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request: expected a single JSON-RPC 2.0 object');
  }
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
  // Notifications (no id) never get a response body: 202 Accepted.
  if (!hasId) {
    return new Response(null, { status: 202 });
  }
  const id = body.id;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request: missing jsonrpc "2.0" or method');
  }
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  switch (body.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' && params.protocolVersion ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-mail', title: 'AgentBox', version: '0.3.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const result = await mcpCallTool(req, env, domain, toolName, params.arguments);
      if (result === null) return rpcError(id, -32602, 'Unknown tool: ' + (toolName || '(missing name)'));
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, 'Method not found: ' + body.method);
  }
}

/* ---------- fetch handler ---------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const domain = env.DOMAIN || 'mail.example.com';

    if (path === '/health') {
      return json({ ok: true, service: 'agent-mail', domain, inboxes: await inboxCount(env) });
    }

    if (path === '/install.md') {
      return new Response(INSTALL_MD, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    }
    if (path === '/llms.txt') {
      return new Response(LLMS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (path === '/mcp') {
      return handleMcp(req, env);
    }

    if (path === '/') {
      const n = await inboxCount(env);
      const html = '<!doctype html><meta charset="utf-8"><title>AgentBox</title>' +
        '<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px">' +
        '<h1>AgentBox</h1><p>给 AI agent 用的专属邮箱：程序开箱、自动提取验证码和确认链接、新信主动通知。' +
        '这是自用 MVP，只开放 API，不提供网页邮箱界面。（技术说明：本站由 Worker <code>agent-mail</code> 提供服务。）</p>' +
        '<p>收件域名：<code>' + domain + '</code> · 当前邮箱数：' + n + '</p>' +
        '<p>For agents: start with <a href="/install.md">install.md</a> (machine-readable setup guide), ' +
        'see <a href="/llms.txt">llms.txt</a> for a short index, or connect MCP clients to <code>POST /mcp</code>.</p></body>';
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Webhook test sink: POST records, GET (admin) reads.
    if (path === '/sink') {
      if (req.method === 'POST') {
        const body = await req.text();
        const raw = await env.KV.get('sink|log');
        const log = raw ? JSON.parse(raw) : [];
        log.push({
          ts: new Date().toISOString(),
          signature: req.headers.get('x-agent-mail-signature'),
          timestamp: req.headers.get('x-agent-mail-timestamp'),
          event_id: req.headers.get('x-agent-mail-event-id'),
          inbox: req.headers.get('x-agent-mail-inbox'),
          body: body.slice(0, 4000),
        });
        await env.KV.put('sink|log', JSON.stringify(log.slice(-50)));
        return json({ ok: true });
      }
      if (req.method === 'GET') {
        if (!isAdmin(req, env)) return json({ error: 'admin token required' }, 401);
        const raw = await env.KV.get('sink|log');
        return json({ callbacks: raw ? JSON.parse(raw) : [] });
      }
    }

    // Create inbox (admin only).
    if (path === '/inboxes' && req.method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'admin token required' }, 401);
      let body = {};
      try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const r = await createInboxCore(env, domain, body);
      return json(r.body, r.status);
    }

    // Read APIs.
    const m = path.match(/^\/inboxes\/([^/]+)\/(messages|wait)(?:\/([^/]+))?$/);
    if (m) {
      const addr = decodeURIComponent(m[1]).toLowerCase();
      const auth = await authedInbox(req, env, addr);
      if (auth.error) return auth.error;
      const inbox = auth.inbox;

      if (m[2] === 'messages' && !m[3] && req.method === 'GET') {
        return json(await listMessagesCore(env, addr, url.searchParams.get('limit')));
      }
      if (m[2] === 'messages' && m[3] && req.method === 'GET') {
        const msg = await getMsg(env, addr, decodeURIComponent(m[3]));
        if (!msg) return json({ error: 'message not found' }, 404);
        return json(msg);
      }
      if (m[2] === 'wait' && req.method === 'GET') {
        const timeout = Math.min(parseInt(url.searchParams.get('timeout') || '30', 10) || 30, 55);
        return json(await waitMessagesCore(env, addr, timeout, url.searchParams.get('after')));
      }
      return json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found' }, 404);
  },

  /* ---------- email handler ---------- */

  async email(message, env, ctx) {
    const to = (message.to || '').toLowerCase().trim();
    const inbox = await getInbox(env, to);
    if (!inbox) {
      console.log('[agent-mail] drop mail to unknown inbox ' + to);
      return;
    }
    // Daily flood guard.
    const today = todayUTC();
    if (inbox.day !== today) { inbox.day = today; inbox.day_count = 0; }
    if (inbox.day_count >= DAILY_LIMIT) {
      inbox.dropped_count = (inbox.dropped_count || 0) + 1;
      await putInbox(env, inbox);
      console.log('[agent-mail] drop over-limit mail inbox=' + to + ' dropped=' + inbox.dropped_count);
      return;
    }

    const rawBuf = await new Response(message.raw).arrayBuffer();
    let parsed = {};
    try { parsed = await PostalMime.parse(rawBuf); } catch (e) {
      console.log('[agent-mail] MIME parse failed inbox=' + to + ' err=' + String(e && e.message || e));
    }
    const html = parsed.html || '';
    const text = (parsed.text || stripHtml(html) || '').trim();
    const { links, confirm_links } = extractLinks(text, html);
    const codes = extractCodes(text);
    const attachments = (parsed.attachments || []).map((a) => ({
      filename: a.filename || 'unnamed',
      mime_type: a.mimeType || 'application/octet-stream',
      size: a.content ? a.content.byteLength || a.content.length || 0 : 0,
    }));
    const id = Date.now().toString(36) + '-' + randHex(3);
    const msg = {
      id,
      event_id: 'evt_' + randHex(8),
      inbox: to,
      from: (parsed.from && (parsed.from.address || parsed.from.name)) || message.from || '',
      subject: parsed.subject || message.headers.get('subject') || '',
      text,
      html_present: !!html,
      codes,
      links,
      confirm_links,
      attachments,
      raw_size: rawBuf.byteLength,
      received_at: new Date().toISOString(),
    };
    await env.KV.put('msg|' + to + '|' + id, JSON.stringify(msg));
    const idx = await getIdx(env, to);
    idx.push(id);
    await env.KV.put('idx|' + to, JSON.stringify(idx.slice(-2000)));
    inbox.day_count += 1;
    await putInbox(env, inbox);
    console.log('[agent-mail] stored msg=' + id + ' inbox=' + to + ' codes=' + codes.length + ' links=' + links.length);

    if (inbox.webhook_url) {
      ctx.waitUntil((async () => {
        const result = await fireWebhook(env, inbox, msg);
        msg.webhook = result;
        await env.KV.put('msg|' + to + '|' + id, JSON.stringify(msg));
      })());
    }
  },
};
