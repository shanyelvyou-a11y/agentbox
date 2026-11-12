// v2 acceptance harness — drives src/index.js directly with in-memory KV.
// Not deployed; run: node tests/v2-harness.mjs
import worker from '../src/index.js';
import crypto from 'node:crypto';

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

// Capture webhook deliveries instead of real fetch.
let deliveries = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  deliveries.push({ url: String(url), headers: opts.headers || {}, body: opts.body || '' });
  return { ok: true, status: 200, json: async () => ({}) };
};

function mkEnv(extra = {}) {
  return { KV: new KVStub(), DOMAIN: 'mail.example.com', ADMIN_TOKEN: 'test-admin', ...extra };
}
const ctx = () => { let p; return { waitUntil(x) { p = x; }, done: () => p }; };
const adminReq = (path, body) => new Request('http://local' + path, {
  method: 'POST', headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const getReq = (path, key) => new Request('http://local' + path, {
  headers: key ? { authorization: 'Bearer ' + key } : {},
});

async function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hmac(secret, msg) { return crypto.createHmac('sha256', secret).update(msg).digest('hex'); }

const MIME = (to, code) => new TextEncoder().encode(
  `From: Sender <sender@example.com>\r\nTo: ${to}\r\nSubject: Your verification code\r\n` +
  `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
  `Your verification code is ${code}. Confirm here: https://example.com/confirm/abc\r\n`);

async function sendMail(env, to, code) {
  const c = ctx();
  await worker.email({ to, from: 'sender@example.com', raw: MIME(to, code), headers: new Headers() }, env, c);
  if (c.done()) await c.done();
}

/* ---- 1. New inbox: secret returned once, stored server-side ---- */
{
  const env = mkEnv();
  const res = await worker.fetch(adminReq('/inboxes', { name: 'newbox', webhook_url: 'https://sink.example/hook' }), env, ctx());
  const body = await res.json();
  check('create inbox 201', res.status === 201, 'status=' + res.status);
  check('response returns webhook_secret once', typeof body.webhook_secret === 'string' && body.webhook_secret.length === 64);
  check('response returns api_key', typeof body.api_key === 'string');
  const rec = JSON.parse(await env.KV.get('inbox|newbox@mail.example.com'));
  check('secret stored server-side, key only as hash', rec.webhook_secret === body.webhook_secret && rec.key_hash === await sha256hex(body.api_key) && !JSON.stringify(rec).includes(body.api_key));

  /* ---- 2. New-scheme webhook signature verifies ---- */
  deliveries = [];
  await sendMail(env, 'newbox@mail.example.com', '483920');
  check('webhook delivered once', deliveries.length === 1);
  const d = deliveries[0];
  const expect = 'sha256=' + hmac(body.webhook_secret, d.headers['x-agent-mail-timestamp'] + '.' + d.body);
  check('v2 signature verifies (secret, ts.body)', d.headers['x-agent-mail-signature'] === expect);
  check('headers carry timestamp + event_id', !!d.headers['x-agent-mail-timestamp'] && /^evt_/.test(d.headers['x-agent-mail-event-id'] || ''));
  const payload = JSON.parse(d.body);
  check('payload has event_id + timestamp, matches header', payload.event_id === d.headers['x-agent-mail-event-id'] && String(payload.timestamp) === d.headers['x-agent-mail-timestamp']);
  const bad = 'sha256=' + hmac('wrongsecret', d.headers['x-agent-mail-timestamp'] + '.' + d.body);
  check('wrong secret does NOT verify', bad !== d.headers['x-agent-mail-signature']);
  const msgs = await (await worker.fetch(getReq('/inboxes/newbox@mail.example.com/messages', body.api_key), env, ctx())).json();
  check('stored message carries event_id + code extracted', msgs.messages[0] && msgs.messages[0].id && JSON.parse(await env.KV.get('msg|newbox@mail.example.com|' + msgs.messages[0].id)).event_id === payload.event_id && msgs.messages[0].codes.some(c => c.code === '483920'));
}

/* ---- 3. Legacy inbox migration: no secret in record ---- */
{
  const env = mkEnv();
  const legacyKey = 'am_legacytestkey';
  await env.KV.put('inbox|legacy@mail.example.com', JSON.stringify({
    address: 'legacy@mail.example.com', name: 'legacy',
    key_hash: await sha256hex(legacyKey), webhook_url: 'https://sink.example/hook',
    created_at: new Date().toISOString(), day: '2026-11-08', day_count: 0, dropped_count: 0, rule_status: 'verified',
  }));
  deliveries = [];
  await sendMail(env, 'legacy@mail.example.com', '112233');
  const rec = JSON.parse(await env.KV.get('inbox|legacy@mail.example.com'));
  check('legacy inbox lazily backfilled a secret', typeof rec.webhook_secret === 'string' && rec.webhook_secret.length === 64);
  check('legacy key_hash untouched by migration', rec.key_hash === await sha256hex(legacyKey));
  const d = deliveries[0];
  const expect = d && 'sha256=' + hmac(rec.webhook_secret, d.headers['x-agent-mail-timestamp'] + '.' + d.body);
  check('legacy webhook verifies under backfilled secret', !!d && d.headers['x-agent-mail-signature'] === expect);
  const listRes = await worker.fetch(getReq('/inboxes/legacy@mail.example.com/messages', legacyKey), env, ctx());
  check('legacy inbox still readable with old key', listRes.status === 200);
}

/* ---- 4. Capacity soft cap ---- */
{
  const env = mkEnv({ MAX_INBOXES: '1' });
  const r1 = await worker.fetch(adminReq('/inboxes', { name: 'first' }), env, ctx());
  const r2 = await worker.fetch(adminReq('/inboxes', { name: 'second' }), env, ctx());
  const b2 = await r2.json();
  check('first create under cap = 201', r1.status === 201);
  check('over-cap create = 429 with limit info', r2.status === 429 && b2.limit === 1, 'status=' + r2.status);
  check('over-cap create stored nothing', (await env.KV.get('inbox|second@mail.example.com')) === null);
}

/* ---- 5. Auth regression ---- */
{
  const env = mkEnv();
  const a = await (await worker.fetch(adminReq('/inboxes', { name: 'boxa' }), env, ctx())).json();
  const b = await (await worker.fetch(adminReq('/inboxes', { name: 'boxb' }), env, ctx())).json();
  const noKey = await worker.fetch(getReq('/inboxes/boxa@mail.example.com/messages'), env, ctx());
  const wrong = await worker.fetch(getReq('/inboxes/boxa@mail.example.com/messages', 'am_nope'), env, ctx());
  const cross = await worker.fetch(getReq('/inboxes/boxb@mail.example.com/messages', a.api_key), env, ctx());
  const own = await worker.fetch(getReq('/inboxes/boxa@mail.example.com/messages', a.api_key), env, ctx());
  check('no key -> 401', noKey.status === 401);
  check('wrong key -> 401', wrong.status === 401);
  check('cross-box key -> 403', cross.status === 403);
  check('own key -> 200', own.status === 200);
  const health = await worker.fetch(getReq('/health'), env, ctx());
  check('/health 200', health.status === 200);
}

/* ---- 6. wait semantics: after cursor + baseline ---- */
{
  const env = mkEnv();
  const bx = await (await worker.fetch(adminReq('/inboxes', { name: 'waiter' }), env, ctx())).json();
  await sendMail(env, 'waiter@mail.example.com', '100001');
  await sendMail(env, 'waiter@mail.example.com', '100002');
  const list = await (await worker.fetch(getReq('/inboxes/waiter@mail.example.com/messages?limit=50', bx.api_key), env, ctx())).json();
  const idsAsc = list.messages.map(m => m.id).reverse(); // API returns newest first
  const w = await (await worker.fetch(getReq(`/inboxes/waiter@mail.example.com/wait?timeout=5&after=${idsAsc[0]}`, bx.api_key), env, ctx())).json();
  check('wait?after=first returns only the second message', w.timed_out === false && w.messages.length === 1 && w.messages[0].id === idsAsc[1]);
  const w2 = await (await worker.fetch(getReq('/inboxes/waiter@mail.example.com/wait?timeout=2', bx.api_key), env, ctx())).json();
  check('wait without after keeps baseline behavior (times out)', w2.timed_out === true && w2.messages.length === 0);
  const w3 = await (await worker.fetch(getReq(`/inboxes/waiter@mail.example.com/wait?timeout=5&after=${idsAsc[1]}`, bx.api_key), env, ctx())).json();
  check('wait?after=last times out (nothing newer)', w3.timed_out === true);
}

globalThis.fetch = realFetch;
const failed = results.filter(r => !r[1]);
console.log('\n== ' + (results.length - failed.length) + '/' + results.length + ' passed ==');
process.exit(failed.length ? 1 : 0);
