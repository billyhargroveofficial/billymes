# Claude Code instructions for Billymes

@AGENTS.md

`AGENTS.md` is the authoritative, complete instruction set for this repository
and is imported above so Claude Code receives the same rules as Codex and other
coding agents. Read it in full before taking action, with the **Billymes fork
overlay** taking precedence over generic upstream workflow text.

In particular, do not mistake this for a disposable upstream checkout: it is
the live `billy/production` source tree. Read `OWNED_PATCHES.md`, preserve the
`origin/main` mirror policy, release through `billymes-update`, and preserve the
provider-hosted semantics described in the hosted-tool contract. Reload replay
uses the per-profile `presentation.db` sidecar plus
`session.presentation.list`; fake function calls or synthetic tool-result
transcript rows are explicitly not an acceptable replacement.
The WebUI reconciles this ledger at each terminal turn boundary. Keep live tool
events as the fast path and the generation-guarded terminal read as recovery
for a lost WebSocket lifecycle frame.
Persisted Codex commentary is restored from a client-safe `interim_messages`
projection of semantic `codex_message_items` phases. Keep raw Responses
sidecars private (including `api_content`, `reasoning_details`, and `codex_*`),
preserve profile visibility gates plus live redaction, and
reconstruct stable commentary segments before hosted cards and final prose;
never duplicate them as model-facing assistant rows or deduplicate by text.
Do not pre-push a new local production commit to appease updater preflight: the
updater itself verifies that the remote SHA is an exact ancestor, deploys the
tested candidate, and publishes it only after service health passes.

For WebUI work, treat `webui/` as an in-tree package, not a separate checkout.
Read `webui/AGENTS.md`; production source stays in this fork and only the
`%h/billymes-ui/env` runtime file is external/private. Keep the production
`/__mes/gateway` 404 and the hosted-tool presentation-ledger replay invariant.
The WebUI also owns durable session selection, event-sequence replay, bounded
history pagination, profile-scoped attachments, and key-gated production
proxying; preserve those contracts when changing chat or transport code.
For replay, `session.events.since` atomically exposes `durable_seq` (successful
persistence) and `replay_base_seq` (the prefix safe to omit after hydration or
explicit supersession). Refresh REST after observing the replay base, drop only
frames through that base, and then apply the protected current tail plus
concurrently buffered live frames through the same monotonic sequence gate.
For an active F5, REST may already include incrementally persisted active-tail
rows. Send/apply `session.resume` before a slow messages request so the gateway
does not orphan-reap a valid reconnect. The gateway's
`history_anchor_display_key` is a clone-safe immutable key from the exact raw
display-deduplication identity, never a physical row id or text heuristic;
`through_display_key` cuts the server history before pagination and returns a
found marker. Hydrate that bounded prefix, let replay own the active tail, and
retain the same boundary for older-page requests until a full unbounded rebase.
If no boundary is confirmed, older-page loading must stay disabled for that
active projection rather than reintroducing an unbounded persisted tail; a
later `found=false` page is rejected rather than prepended.
Even a terminal event at or below the replay base must settle busy/active
runtime state. Reap grace is only a safety net, not a replacement for this
ordering.
Remember that `session.create` is intentionally non-persistent. Its first
sidebar refresh belongs after `prompt.submit` settles, when the durable row is
known to exist (or may exist after a lost ACK). During compression the live id
does not rotate with the durable id: preserve and replay the exact
`session.identity` previous-to-current edge, and let the selected WebUI session
atomically rebind its history id before refreshing the catalog.
Reconnect recovery is generation-owned; a stale attempt must not clear a newer
attempt's buffer. Never content-dedupe assistant text/tools, never advance
across `truncated`, and never allow an unbounded baseline-stabilization loop.
For paged history, `include_compacted=true` is a compression-only logical
root-to-tip display read and `pagination.user_turn_offset` is the count of
visible user turns before that chronological page. It must be computed from the
same deduplicated projection the endpoint returns; otherwise hosted cards bind
to the wrong turn after a reload or an older-page fetch.

The direct `openai-codex` path is also owned code: it uses a persistent native
Responses WebSocket with strict `previous_response_id` continuation and an
HTTP/SSE fallback. Catalog-approved lite requests are allowed only when no
hosted tool is declared; hosted tools remain on classic Responses. Preserve the
bundled `plugins/web/codex-native` provider and profile-local OAuth behavior;
do not restore a machine-local override or require `codex app-server`.
