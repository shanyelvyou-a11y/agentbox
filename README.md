# AgentBox

**Email inboxes for AI agents** — an open-source, self-hosted inbox service that
gives any AI agent its own email address: create inboxes by API, receive mail
with verification codes and confirmation links extracted as structured JSON,
and get notified by signed webhook or long-poll. Runs on Cloudflare Workers +
KV at near-zero cost: the Cloudflare free tier (Email Routing included) covers
typical self-hosted use — up to 150 inboxes by default (see Limits).

Agents don't read raw MIME. AgentBox parses every incoming message for them:
OTP / verification codes (with confidence levels), confirmation links, all
links, and attachment metadata — then serves the result over a REST API or a
native MCP server, so a tool-using agent can work its inbox directly.

## Why AgentBox (vs. hosted agent-mail SaaS such as AgentMail)

| | AgentBox | Hosted SaaS (e.g. AgentMail) |
|---|---|---|
| Source | Open source (MIT), self-hosted | Closed, hosted only |
| Cost | Your Cloudflare account; free tier covers typical use | Per-inbox subscription |
| Data | Parsed messages live in your own KV namespace (raw MIME and attachment files are not stored) | On the vendor's servers |
| Scope | Receive-only by design (codes/links/notifications) | Send + receive |
| Integration | REST API + MCP server + machine-readable `install.md` | API / SDK |

AgentBox deliberately does **one thing**: receiving. Sending is out of scope —
pair it with any send provider if you need outbound mail.

## Quick start

> ⚠️ Keep the Worker name `agent-mail` (the default in
> `wrangler.toml.example`), or update the Worker name hard-coded in
> `src/index.js` (`cfCreateRule`) to match — routing rules are created
> pointing at that Worker by name. Renaming only one side silently breaks
> inbox creation.

You need:

- A Cloudflare account (free tier is fine).
- A domain (or subdomain) on that account with **Email Routing enabled** —
  this is the domain your inboxes will live on, e.g. `mail.example.com`.
  To enable it: Cloudflare dashboard → your domain → *Email → Email Routing*
  → *Enable*; Cloudflare adds the required MX/SPF records for you. (AgentBox
  creates a literal routing rule per inbox automatically at inbox creation;
  you do not need to pre-create address rules.)
- Node.js + `wrangler` (`npm i -g wrangler`, or use `npx wrangler`).
- A Cloudflare API token for rule creation: **Zone → Email Routing → Write**
  (plus Zone Read), scoped to your one zone. Create it in the Cloudflare
  dashboard under *My Profile → API Tokens*.

Steps:

```bash
git clone <this-repo> agentbox && cd agentbox
npm install

# 1. Create the KV namespace that will store inboxes and messages
npx wrangler kv namespace create agentbox

# 2. Configure
cp wrangler.toml.example wrangler.toml
#    edit wrangler.toml: paste the KV id into [[kv_namespaces]] (keep
#    binding = "KV" — the code reads env.KV), set DOMAIN, and set
#    CF_ZONE_ID (find it in the dashboard: your domain → Overview →
#    right-hand sidebar → Zone ID)

# 3. Set the two secrets (values are yours; never commit them)
npx wrangler secret put ADMIN_TOKEN    # operator token; guards inbox creation
npx wrangler secret put CF_API_TOKEN   # the Email Routing token from above

# 4. Deploy
npx wrangler deploy
```

Then follow the machine-readable **[install.md](install.md)**: it contains the
full quickstart (create an inbox → send a test email → read back the extracted
code), an executable self-check script, an MCP client configuration example,
and a troubleshooting table. `llms.txt` is the short index for LLM tools.

## How it works

- One Worker (`src/index.js`): HTTP API + MCP endpoint + Cloudflare Email
  Routing `email` handler.
- Storage is a single KV namespace:
  `inbox|<addr>` inbox record (API key stored as SHA-256 hash only, plus a
  per-inbox `webhook_secret`), `idx|<addr>` message id index,
  `msg|<addr>|<id>` message records, `sink|log` webhook test log.
- Creating an inbox automatically creates the literal Email Routing rule for
  that address (pointing at this Worker) through the Cloudflare API and reads
  it back to verify (`rule_status` in the create response).
- Extraction is local and free — no paid AI APIs: links from text + HTML
  anchors; confirmation links by confirm/verify/activate semantics; codes by
  keyword proximity (high), standalone 6-digit (medium), other 5–8 digit
  (low), each with a context snippet.

## API summary

Full details in [install.md](install.md).

- `GET /health` → `{ok, service, domain, inboxes}`
- `POST /inboxes` (ADMIN token) `{name, webhook_url?}` →
  `{address, api_key, webhook_secret, rule_status}` — `api_key` and
  `webhook_secret` are returned **exactly once**. Past `MAX_INBOXES`
  (default in the example config: 150) creation returns `429`.
- Read mail (per-inbox API key as `Authorization: Bearer <api_key>`; a key
  only ever opens its own inbox — no key → 401, another inbox's key → 403):
  - `GET /inboxes/{addr}/messages?limit=50` — newest first, with extractions
  - `GET /inboxes/{addr}/messages/{id}` — full message
  - `GET /inboxes/{addr}/wait?timeout=30&after={message_id}` — long-poll;
    `after` is your cursor, only newer messages are returned
- `GET /install.md`, `GET /llms.txt` — machine-readable docs, served live
  (source of truth: `src/docs.js`, dual-written with the repo-root files).

### MCP

`POST /mcp` — stateless Streamable HTTP, JSON-RPC 2.0, one request → one JSON
response (no SSE, no sessions). Tools:

- `create_inbox` (ADMIN token) `{name, webhook_url?}`
- `list_messages` `{address, limit?}`
- `get_message` `{address, message_id}`
- `wait_for_message` `{address, timeout_seconds? (default 20, max 50), after?}`

The token travels in the MCP request's `Authorization: Bearer` header — the
ADMIN token for `create_inbox`, the inbox's own API key for the other tools.
There is no anonymous access.

### Webhooks

If `webhook_url` was set at creation, every new message is POSTed as
structured JSON `{event: "message.received", event_id, timestamp, inbox,
message}` with headers `X-Agent-Mail-Signature`
(`sha256=` + HMAC-SHA256(`webhook_secret`, `timestamp + "." + body`)),
`X-Agent-Mail-Timestamp`, `X-Agent-Mail-Event-Id`. Delivery is attempted up
to 3 times (backoff 1 s, then 3 s); the final status is recorded on the
message record. Dedupe retries by `event_id`. Test sink: `POST /sink` records callbacks,
`GET /sink` (ADMIN token) reads them back.

## Limits

- **Receive-only.** No sending in this version.
- **500 messages per inbox per day**; excess is dropped and counted.
- **Attachments are metadata only** (name, MIME type, size) — bodies are not
  stored.
- **200 Email Routing rules per zone** (Cloudflare platform limit), shared
  with all other rules in the zone; each inbox consumes one literal rule, so
  plan `MAX_INBOXES` with headroom.
- **KV is eventually consistent**: a new message can take a few seconds to
  become visible; re-read after ~10 s before concluding mail is missing.
- Wait caps: REST `wait` max 55 s, MCP `wait_for_message` max 50 s — loop for
  longer waits.

## Security notes

- `api_key` and `webhook_secret` are shown **exactly once**, in the create
  response. The server stores only a hash of the API key — a lost key cannot
  be recovered; the operator must create a new inbox. Store both values in a
  secret store immediately.
- `ADMIN_TOKEN` can create inboxes. Keep it server-side
  (`wrangler secret put`), never in client code, prompts, or logs.
- `CF_API_TOKEN` should be scoped to the single zone with only Email Routing
  write + zone read permissions.
- Verify webhook signatures before trusting payloads, and dedupe by
  `event_id` — the same message may be delivered by the sender more than
  once, and `event_id` identifies a delivery event, not the message itself;
  use a content hash as your idempotency key if you need message-level
  deduping.
- **Webhook targets must be external URLs.** Cloudflare Workers cannot call
  back their own `workers.dev` address. Point `webhook_url` at an external
  endpoint or a custom domain, not at this Worker's own address.
- Inbox creation is admin-only by design. Do not expose `ADMIN_TOKEN` to
  end-user agents — hand each agent only its own inbox key.

## Development

```bash
npm test   # node tests/v2-harness.mjs && node tests/mcp-harness.mjs
```

Both harnesses run the Worker against an in-memory KV stub — no Cloudflare
account needed.

## License

MIT — see [LICENSE](LICENSE).
