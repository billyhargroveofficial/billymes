# Gateway

The gateway capsule owns browser-to-Hermes transport, gateway settings, the
WebSocket client/provider, and the gateway configuration sheet.

## Public surface

Consumers use [`index.ts`](index.ts). Its narrow surface exports
`GatewayClient`, `GatewayProvider`, `useGateway`, `GatewaySheet`,
`hostFromOrigin`, and the event/connection types used by chat. Keep health,
settings persistence, proxy normalization, and socket internals private.

The capsule has no feature dependencies in [`module.json`](module.json). The
server forwarding boundary lives separately under `server/` and is wired by the
Vite configuration. `gateway-proxy.ts` is its orchestration/public surface;
runtime, control, and forwarding details stay in focused sibling modules.

## Security boundary

### Loopback by default

The Vite server accepts loopback values through `HERMES_UI_HOST` and rejects
non-loopback bindings. The built-in server has no LAN mode; do not publish it
through an unauthenticated reverse proxy.

The gateway control and credential-bearing proxy paths require a loopback peer,
loopback Host, and same-origin browser request metadata.

### Token handling

Origin/mode/host settings may survive a browser restart, but the browser token
must not. `gateway-settings.ts` binds the session token to its canonical origin
and Host in `sessionStorage`; it writes only non-token settings to `localStorage`
and discards any legacy token field found there rather than rebinding it. The
server keeps the active token in its in-memory runtime and returns only
`tokenSet` in public runtime information.

The proxy keeps mutable target/token state per browser JavaScript realm. The
shared runtime identity travels in `X-Mes-Runtime` for HTTP/control requests
and in `__mes_runtime` for WebSocket handshakes; the proxy validates and strips
both internal transport values before forwarding. The registry is bounded and
expires idle entries without evicting a control request whose body or mutation
is pending. Requests without an identity use configured defaults for read-only
traffic, while gateway and upstream mutations require an identity. Mutation
sequence is assigned when the request is received, so a slower older body cannot
overwrite a newer completed setting.

The runtime identity partitions local state; it is not authentication. Loopback
peer/Host checks plus same-origin browser metadata remain the supported security
boundary.

The token must not appear in URLs, runtime-info responses, logs, screenshots, or
new persistent browser storage. Do not add a client-side refresh or credential
cache without a separate security decision.

### Proxy header hygiene

The server gateway removes client-provided `authorization`, cookies, forwarding
headers, proxy-auth headers, and hop-by-hop headers before forwarding.
It sets the configured runtime Bearer header and the validated target host/origin
itself. WebSocket forwarding adds only the required `Connection: Upgrade` and
`Upgrade: websocket` handshake headers. Response hop-by-hop/proxy-auth headers
are sanitized before returning to the browser.

Keep control-body size limits, absolute HTTP(S) origin validation, host
validation, and request/connection teardown intact when changing the proxy.

## Runtime shape

```text
gateway/
  api/gateway-api.ts             typed health call
  model/GatewayClient.ts         generation-safe JSON-RPC WebSocket client
  model/GatewayProvider.tsx      settings/runtime/epoch context
  model/gateway-settings.ts      session-scoped token + safe settings storage
  ui/GatewaySheet.tsx            local/remote connection controls
server/gateway-proxy.ts          loopback/origin gate and plugin orchestration
server/gateway-runtime.ts        runtime validation, identity, and registry
server/gateway-control.ts        control body limits and mutation FIFO
server/gateway-forwarding.ts     HTTP/WS forwarding and header hygiene
```

`GatewayProvider` applies settings, clears query state, and advances the
connection epoch. `useGatewayConnection` creates one client per active epoch,
gets a fresh ticket, retries with bounded backoff, and closes it on cleanup.
`GatewayClient` ignores stale socket generations and rejects pending requests on
replacement or close.

## Focused tests

Keep deterministic tests close to the gateway owner for:

- loopback-only binding, same-origin enforcement, and remote-control rejection;
- same-origin control and origin/host validation;
- client header stripping and runtime Bearer injection;
- absence of a persistent browser token and `tokenSet` redaction;
- socket generation replacement, timeout, pending-request rejection, and
  cleanup close/reconnect cancellation.

Use fake sockets and local HTTP doubles only. Never use a real Hermes gateway,
SSH tunnel, minted token, or `.env.local` in tests. Finish with the canonical
commands in [`docs/development.md`](../../../docs/development.md).
