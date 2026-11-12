# AgentBox — Install & Integration Guide (for AI agents and their operators)

This document is written for machines first. If you are an AI agent (or a script)
reading this, you can follow the Quickstart top to bottom and end with a working
email inbox, without any human UI.

## What this is / when to use it

AgentBox gives an AI agent its own email inbox on the domain
`mail.example.com`. Incoming mail is parsed automatically: verification
codes (OTP), confirmation links, and all links are extracted into structured
JSON, so you never parse raw MIME yourself.

Use AgentBox when you (an agent) need to:

- receive a verification code while signing up for a service,
- receive a confirmation / magic login link and follow it,
- wait for an asynchronous email notification and react to it,
- get a webhook POST the moment new mail arrives.

Do NOT use it to send mail: AgentBox is receive-only.

Base URL: `https://agentbox.example.com`
Receiving domain: `mail.example.com`
MCP endpoint: `https://agentbox.example.com/mcp`

## Two ways to connect

### Option A — REST API

- Create inbox (operator only): `POST /inboxes`
  Header: `Authorization: Bearer <ADMIN_TOKEN>`
  Body: `{"name": "myagent", "webhook_url": "https://example.com/hook"}` (`webhook_url` optional)
- List messages: `GET /inboxes/{address}/messages?limit=50`
  Header: `Authorization: Bearer <INBOX_API_KEY>`
- Get one message: `GET /inboxes/{address}/messages/{message_id}`
  Header: `Authorization: Bearer <INBOX_API_KEY>`
- Wait for new mail: `GET /inboxes/{address}/wait?timeout=30&after={message_id}`
  Header: `Authorization: Bearer <INBOX_API_KEY>`
- Health: `GET /health` (no auth)

The header `X-Api-Key: <key>` is also accepted instead of the Bearer header.

### Option B — MCP (Model Context Protocol)

- Endpoint: `POST https://agentbox.example.com/mcp`
- Transport: stateless Streamable HTTP. One JSON-RPC 2.0 request per POST, one
  JSON response. No SSE stream, no session id.
- Auth: the token travels in the `Authorization: Bearer <token>` header of the
  MCP HTTP request — the ADMIN token for `create_inbox`, the per-inbox API key
  for every other tool. There is no anonymous access.
- Tools:
  - `create_inbox` `{name, webhook_url?}` — create an inbox (admin token).
  - `list_messages` `{address, limit?}` — newest first, with extracted codes/links.
  - `get_message` `{address, message_id}` — full body of one message.
  - `wait_for_message` `{address, timeout_seconds? (default 20, max 50), after?}` — long-poll for new mail.
- Tool success result: `content[0].text` is a JSON string and
  `structuredContent` holds the same object. Tool failure: `isError: true` and
  `content[0].text` is a JSON object `{"error": "...", "status": <http-like status>}`.

## Quickstart (follow in order)

1. Ask the operator for the ADMIN token. Only the operator can create inboxes.
   Keep it in an environment variable, never in code or in a prompt log:
   `export AGENT_MAIL_ADMIN="..."`.
2. Create your inbox (REST):

   ```bash
   curl -s -X POST https://agentbox.example.com/inboxes \
     -H "Authorization: Bearer $AGENT_MAIL_ADMIN" \
     -H "Content-Type: application/json" \
     -d '{"name": "myagent"}'
   ```

   Or over MCP: call tool `create_inbox` with `{"name": "myagent"}` while the
   MCP request carries the admin token (see config example below).
3. **Save the credentials from the create response immediately.** The response
   contains `address`, `api_key`, and `webhook_secret`. WARNING: `api_key` and
   `webhook_secret` are returned **exactly once**, in this response only. The
   server stores only a hash of `api_key`, so a lost key cannot be recovered —
   the operator must create a new inbox. Store both values in your secret
   store now:

   ```bash
   export AGENT_MAIL_ADDRESS="myagent@mail.example.com"
   export AGENT_MAIL_KEY="<your api_key>"   # api_key from the create response
   export AGENT_MAIL_WEBHOOK_SECRET="..."  # webhook_secret from the create response
   ```

4. Send a test email to your new address from any external mailbox. Put a
   6-digit code and a confirmation link in it, e.g. body:
   `Your verification code is 483920. Confirm here: https://example.com/confirm/abc`
5. After about 10 seconds (storage is eventually consistent, see Troubleshooting),
   read the inbox and check the extraction:

   ```bash
   curl -s "https://agentbox.example.com/inboxes/$AGENT_MAIL_ADDRESS/messages?limit=5" \
     -H "Authorization: Bearer $AGENT_MAIL_KEY"
   ```

   The message summary must contain `codes: [{code: "483920", ...}]` and the
   URL in `confirm_links`. If both are present, integration works.
6. From now on, wait for mail efficiently instead of polling:
   - Remember the `id` of the newest message you have consumed.
   - Call `wait_for_message` (or `GET .../wait`) with `after` set to that id.
   - `after` cursor semantics: everything up to and including the `after`
     message id counts as already seen; the call returns only messages that
     arrived **after** that cursor — including messages that arrived before
     the call started. An unknown `after` id falls back to "everything current
     is seen". Without `after`, the baseline is the moment the call starts.
   - Save the newest returned message id as your next `after` cursor so you
     never consume a message twice.
   - A result with `timed_out: true` and an empty `messages` list is a NORMAL
     result (nothing arrived in time), not an error. Just call again.
7. Optional webhook: if you passed `webhook_url` at creation, every new
   message triggers a POST with headers `X-Agent-Mail-Signature`
   (`sha256=` + HMAC-SHA256 of `timestamp + "." + body`, keyed with your
   `webhook_secret`), `X-Agent-Mail-Timestamp`, and `X-Agent-Mail-Event-Id`.
   Verify the signature before trusting the payload, and dedupe by `event_id`.

## MCP client configuration example

Point any MCP client at the remote server. Use the admin token in the header
only for a client that must call `create_inbox`; for day-to-day reading, use
the inbox's own API key.

```json
{
  "mcpServers": {
    "agent-mail": {
      "url": "https://agentbox.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <INBOX_API_KEY>"
      }
    }
  }
}
```

Minimal raw check that the MCP endpoint answers:

```bash
curl -s -X POST https://agentbox.example.com/mcp \
  -H "Authorization: Bearer $AGENT_MAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Executable self-check (bash)

Requires: `curl`, `python3`, env vars `AGENT_MAIL_ADMIN` (admin token).
It verifies health, creates a throwaway inbox, and lists its messages.
Note: the test inbox counts against the inbox capacity; delete is not
supported, so run this sparingly (or reuse one fixed test name — a second run
then reports 409 "inbox already exists", which also proves create works).

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://agentbox.example.com"
NAME="${1:-selfcheck}"

echo "== health =="
curl -s "$BASE/health" | grep -q '"ok": true' && echo "health OK"

echo "== create inbox =="
RESP=$(curl -s -X POST "$BASE/inboxes" \
  -H "Authorization: Bearer $AGENT_MAIL_ADMIN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$NAME\"}")
echo "$RESP"
API_KEY=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("api_key",""))')
ADDR=$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("address",""))')
if [ -z "$API_KEY" ]; then echo "create did not return an api_key (maybe 409: inbox already exists)"; exit 1; fi

echo "== list messages (expect 200 with count field) =="
curl -s "$BASE/inboxes/$ADDR/messages?limit=5" -H "Authorization: Bearer $API_KEY"
echo
echo "SELF-CHECK OK: inbox $ADDR works. Now send a test email to it and re-run the list call."
```

## Troubleshooting / failure recovery

| Symptom | Meaning | What to do |
|---|---|---|
| HTTP 401 / tool error `status: 401` | Missing or wrong token/key. For `create_inbox` you used an inbox key instead of the ADMIN token, or the key does not exist. | Check the `Authorization: Bearer ...` header. Use the admin token for create, the inbox's own `api_key` for reads. |
| HTTP 403 / `status: 403` "api key belongs to a different inbox" | The key is real but belongs to another inbox. Keys are strictly per-inbox. | Use the key that was returned when THIS address was created. |
| HTTP 404 "inbox not found" | The address does not exist (typo, or created on a different server/domain). | Re-check the full address from the create response. |
| HTTP 404 "message not found" | Wrong `message_id` for this inbox. | Take ids from `list_messages` / `wait_for_message` output for the same address. |
| HTTP 429 "inbox capacity reached" | The server hit its inbox cap (`MAX_INBOXES`, default 200). Nothing was created. | Ask the operator to raise the cap or clean up. Do not retry in a loop. |
| Create succeeded but messages never appear | The routing rule may have failed, or storage has not propagated yet. | Wait 10 seconds and re-read (KV is eventually consistent). Check `rule_status` in the create response: if it is `failed`, see the next row. |
| `rule_status: "failed"` in create response | The Cloudflare Email Routing rule for this address could not be created (usually an expired/insufficient operator API token). The inbox record exists but mail will NOT be delivered to it. | Operator action: renew the server-side Cloudflare token, then re-create the inbox under a fresh name (or add the rule manually in the Cloudflare dashboard, Email Routing, literal rule to Worker `agent-mail`). Do not keep sending test mail to the broken address. |
| New mail sent, list still empty after ~10 s | Eventual consistency or the sender is slow. | Wait 10 seconds and call `list_messages` again. If still empty after a minute, verify the sender really sent to the exact address. |
| `timed_out: true` from wait | Normal. No new message arrived within the timeout window. | Not an error. Call `wait_for_message` again, ideally with `after` = last consumed message id. |
| HTTP 405 on `/mcp` | You used GET. The MCP endpoint is POST-only. | Send JSON-RPC with POST. |
| JSON-RPC error `-32601` | Unknown MCP method name. | Use only `initialize`, `ping`, `tools/list`, `tools/call`. |
| Webhook signature mismatch | You verified with the wrong secret or the wrong string. | Recompute HMAC-SHA256 with the inbox `webhook_secret` over exactly `timestamp + "." + raw_body`, using the `X-Agent-Mail-Timestamp` header value and the raw, unparsed body. |

## Hard limits (plan around these)

- **Receive-only.** No sending (no SMTP, no send API) in this version.
- **500 messages per inbox per day.** Excess mail is dropped and counted.
- **Attachments are metadata only** (filename, MIME type, size). File bodies
  are not stored and cannot be downloaded.
- **Inbox cap:** total inboxes per server deployment is capped by
  `MAX_INBOXES` (default 200). Create returns 429 past the cap.
- **Email Routing rule limit: 200 rules per zone**, shared with every other
  rule in the zone. Each inbox consumes exactly one literal Email Routing
  rule, so the rule count grows 1:1 with the inbox count — the 200 cap is a
  hard platform ceiling, not just a server setting.
- **Wait caps:** REST `wait` timeout max 55 s; MCP `wait_for_message`
  `timeout_seconds` max 50 s. Loop the call for longer waits.
- **Eventual consistency:** storage (Cloudflare KV) can lag a few seconds;
  re-read after ~10 s before concluding mail is missing.
- **Credentials are shown once:** `api_key` and `webhook_secret` appear only
  in the create response. There is no recovery or "show again" endpoint.
