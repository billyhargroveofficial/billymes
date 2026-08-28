# billymes-webui

The WebUI is a source directory in the Billymes fork, not a standalone
repository or deployment artifact. It presents Hermes conversations and the
hosted-tool event ledger without changing their protocol semantics.

## Development

Use Node.js 24–26 and pnpm 11. The normal, side-effect-free local loop is:

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

`pnpm dev` starts only a loopback Vite server. It does not open SSH tunnels,
mint credentials, write environment files, or contact a real gateway. Optional
proxy values are ordinary local environment variables; keep secrets out of the
repository and shell history.

## Production

`pnpm serve` runs the built-in loopback static server and `/api` proxy from the
same checked-out source. The systemd template is
[`systemd/billymes-ui.service`](systemd/billymes-ui.service). Its runtime
environment remains external at `%h/billymes-ui/env` with mode `0600`; source,
dependencies, and `dist/` belong under `%h/.hermes/hermes-agent/webui`.

The production wrapper intentionally returns `404` for `/__mes/gateway`. It is
key-gated: `ACCESS_KEY_SHA256` and `SESSION_SECRET` in the external environment
issue a signed HttpOnly session cookie at `/__access`; only then can API or
WebSocket requests mint and receive an injected short-lived gateway token. The
operator key and gateway token never reach the UI response, logs, or source.
The browser treats the missing development control plane as valid local mode.

The updater (`scripts/billymes-update`) builds this directory, restarts
`billymes-ui.service`, and checks the configured health URL alongside the
Hermes services.

## Boundaries

- Bind only to loopback. The production server rejects non-loopback hosts and
  must retain its access-key/session boundary before a Tailscale Funnel.
- Never put access tokens, private host names, or user paths in source, docs,
  fixtures, logs, or Git history.
- Do not create a nested Git repository or copy a separate WebUI history here.
- Chat replay is presentation-ledger driven: grouped hosted calls remain hosted
  and are rendered as the original individual cards. Do not synthesize normal
  tool messages or reissue calls while replaying. Live lifecycle events are the
  fast path; terminal-turn reconciliation repairs a missed WebSocket frame from
  the same durable ledger before a reload.
- REST may attach safe `interim_messages` to the canonical assistant row. They
  are semantic, redacted Codex commentary projections; reconstruct them as
  stable assistant segments before the hosted-card segment and final prose.
  Never consume raw Responses sidecars or infer duplicates from message text.
- Transcript reload uses the gateway's dual-cursor protocol: `durable_seq`
  reports successful persistence and `replay_base_seq` marks the prefix safe
  to omit after hydration. Protected current replay and concurrently buffered
  socket frames then pass through one monotonic watermark. Do not merge a whole
  retained ring over REST, deduplicate by message text, let stale reconnect
  work clear a newer buffer, or claim a truncated sequence gap.
- During an active-turn F5, REST may already contain incrementally persisted
  assistant/tool rows. Apply `session.resume` before awaiting a slow history
  request so the gateway retains the live turn, then hydrate only the pre-turn
  prefix using its `history_anchor_display_key` as `through_display_key`.
  That clone-safe immutable key derives from the exact raw display-dedupe
  identity—not a row id, timestamp, or message text—and the server cuts before
  pagination and reports whether it found the anchor. Replay is the sole owner
  of the active tail; carry the same boundary into every `load-earlier` request
  until a full unbounded rebase, and disable older-page loading while no exact
  active boundary is confirmed. A terminal frame still clears busy/active
  state even if it is at or below the replay base; an older-page response that
  loses its found marker is rejected, not prepended. The orphan-reap grace is
  only a fallback guardrail, not the recovery design.

See [`AGENTS.md`](AGENTS.md) for edit ownership and [`docs/README.md`](docs/README.md)
for the design notes.
