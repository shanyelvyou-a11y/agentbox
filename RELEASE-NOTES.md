# AgentBox v1.0.0 — Release Notes (draft)

First public release of AgentBox: an open-source, self-hosted email inbox
service for AI agents, running on Cloudflare Workers + KV.

## What's included

- **Inbox core (receive-only)**
  - Create inboxes via API; each creation auto-creates and read-back-verifies
    the literal Cloudflare Email Routing rule for the address.
  - Incoming mail parsed with postal-mime; verification codes (with
    confidence levels and context), confirmation links, all links, and
    attachment metadata extracted locally — no paid AI APIs.
  - Per-inbox daily cap of 500 messages (excess dropped and counted);
    capacity soft cap `MAX_INBOXES` with HTTP 429 past the cap.
- **REST API**
  - `POST /inboxes` (admin), `GET /inboxes/{addr}/messages`,
    `GET /inboxes/{addr}/messages/{id}`,
    `GET /inboxes/{addr}/wait` (long-poll with `after` cursor semantics),
    `GET /health`. Auth semantics: no/wrong key 401, another inbox's key 403,
    unknown inbox 404.
- **MCP server ("the three-piece set", with install.md + baseline below)**
  - `POST /mcp`: stateless Streamable HTTP, JSON-RPC 2.0, single JSON
    response, no sessions.
  - Tools: `create_inbox`, `list_messages`, `get_message`,
    `wait_for_message` — same core logic and auth semantics as REST.
- **Machine-readable onboarding**
  - `install.md`: quickstart an agent can follow end-to-end, MCP client
    config example, executable self-check script, 12-row troubleshooting
    table, hard-limits list. Served live at `GET /install.md`; `llms.txt`
    served at `GET /llms.txt`.
- **Webhooks**
  - Per-inbox `webhook_secret` (separate from the API key, which is
    hash-only and auth-only). Signature:
    `HMAC-SHA256(webhook_secret, timestamp + "." + body)` with timestamp and
    event-id headers; 3 retries; `/sink` test endpoint. Legacy inboxes
    without a secret get one lazily on first delivery.
- **Tests**: two in-memory harnesses (REST/webhook/extraction regression and
  MCP/docs) — 25 + 38 checks, no Cloudflare account needed (`npm test`).

## Limits & known issues

- **No delete-inbox API.** Created inboxes (and their routing rules) can only
  be removed by editing KV / the Cloudflare dashboard manually. The self-check
  script's test inbox also counts against capacity — run it sparingly. If you
  hit the `MAX_INBOXES` cap (429), this manual cleanup is currently the only
  way to free capacity.
- **Lost API keys cannot be recovered.** Only a hash is stored; a lost key
  means creating a new inbox.
- **Webhook delivery** is attempted up to 3 times (backoff 1 s, then 3 s);
  the final status is recorded on the message record and logged, but failed
  deliveries are not re-queued.
- **Eventual consistency.** KV reads can lag a few seconds behind a delivery;
  clients should re-read after ~10 s.
- **Email Routing rule ceiling: 200 rules per zone**, shared zone-wide, and
  each inbox consumes one rule. Default `MAX_INBOXES=150` leaves headroom;
  a catch-all architecture for larger deployments is future work.
- **Webhook targets must be external URLs** — a Worker cannot call back its
  own `workers.dev` address (self-calls fail with 522).
- **Duplicate deliveries are possible** on the sender side; `event_id`
  identifies a delivery event, not the message — dedupe by content hash if
  you need message-level idempotency.
- **Receive-only**: no sending, no webmail UI, no multi-tenant billing.
  Attachments are metadata only.
- The Worker name `agent-mail` is referenced by the routing-rule creation
  code; renaming the Worker requires updating `src/index.js` to match.

## Verification status at release

- Production-proven core: a real external email delivered to a production
  inbox with code + confirmation-link extraction verified, and webhook
  deliveries independently signature-verified at an external receiver (3/3).
- MCP + docs release: local harnesses 25/25 and 38/38; live deployment
  checked with real inbox keys and browser rendering before this release.
