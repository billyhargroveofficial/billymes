# Gateway feature contract

This file records security and lifecycle hazards for the gateway capsule. Read
the root [`AGENTS.md`](../../../AGENTS.md) and
[the feature README](README.md) before changing transport or settings.

## Binding boundary

- `HERMES_UI_HOST` may select loopback only. Non-loopback bindings are rejected;
  the built-in server has no LAN mode or remote authentication layer.
- Do not place an unauthenticated reverse proxy in front of this server. Remote
  access requires a separately designed authentication boundary.
- The `/__mes/gateway`, API, auth, and WebSocket paths require a loopback peer,
  loopback Host, and same-origin browser metadata.
- `/__mes/gateway` is a Vite development control route. The production wrapper
  has no mutable control plane: authenticated local-mode `GET`/`DELETE` probes
  return an empty, non-cacheable `204`; unauthenticated probes and mutation
  methods return `404`. Both the `204` contract and the legacy `404` fallback
  mean a valid fixed same-origin runtime, not a visible proxy failure.
- Do not add a second bind switch, silently broaden the allowlist, or place an
  internal host value in docs, fixtures, logs, or UI copy.

## Credential and header boundary

- Gateway settings may persist origin/mode/host in local storage, but the
  browser token is session-scoped and bound to its canonical origin. New writes
  keep it in `sessionStorage`, not persistent local storage; legacy persisted
  token data is migrated and removed from the settings record on read.
- The server proxy strips client-supplied authorization, cookie, forwarding, and
  hop-by-hop headers before setting the configured runtime Bearer header. For
  WebSocket forwarding it restores only the protocol upgrade headers required by
  the handshake.
- Keep the token in the proxy runtime boundary. Do not expose it through the
  public runtime-info response, URL, logs, or a new browser persistence layer.
- Preserve origin/host validation and the same-origin control check when adding
  gateway settings or proxy routes.

## Lifecycle and tests

`GatewayClient` owns socket generation checks, pending-request rejection,
timeouts, and close behavior. Consumers must unsubscribe and close their client
on unmount; reconnect orchestration belongs in the connection hook, not in UI
components.

Focused tests must use fake sockets, local request/response doubles, and safe
fixtures. They must never open SSH, mint a session, contact a real Hermes
gateway, or use real credentials. Keep tests for loopback authorization,
same-origin control, header stripping, token redaction, origin validation,
socket replacement, timeout, and cleanup close to this capsule.

The server registry keeps control and active WebSocket leases separate. Release
each lease exactly once (the primitive is idempotent), and keep client/upstream
close paths symmetric so a live socket cannot be TTL-evicted mid-session.
