# ADR 0002: Per-tab gateway runtime isolation

Status: Accepted
Date: 2026-08-26

## Context

The local Vite proxy injects a Hermes bearer and allows the operator to change
the upstream origin and Host. One mutable process-wide runtime lets concurrent
browser tabs overwrite each other's target or credential. Request bodies can
also complete out of receipt order, and a state identifier alone must not be
mistaken for an authentication boundary.

## Decision

Partition mutable gateway runtime by one cryptographically random identifier per
browser JavaScript realm/tab. Send it in `X-Mes-Runtime` for HTTP/control and
`__mes_runtime` for WebSocket handshakes; validate and strip it before forwarding
upstream.

Keep a bounded, TTL-based in-memory registry of origin, Host, token, control
FIFO, pending count, and mutation sequence. Pending controls cannot be evicted.
Assign mutation sequence at request receipt, read bounded bodies outside the
FIFO, and reject an older body with `409` if a newer mutation superseded it.
Requests without an identifier may use configured defaults for read-only HTTP;
control/upstream mutations and WebSockets require an identifier.

Bind browser session tokens to canonical origin + Host and clear the token when
either changes. Legacy localStorage token fields are discarded, never migrated
or rebound. Keep loopback peer, loopback Host, and same-origin browser metadata
as the supported security boundary. The runtime identifier partitions state; it
does not authenticate a caller.

## Consequences

Positive:

- tabs cannot overwrite or borrow one another's mutable proxy runtime;
- slow older control bodies cannot win over newer user intent;
- registry growth and idle state are bounded without evicting in-flight work;
- internal routing metadata and bearer values do not cross upstream.

Costs and obligations:

- every browser transport path must carry the same realm identity;
- registry, body, timeout, ordering, and header-stripping tests are security
  contracts and must remain deterministic;
- this remains a local development control plane, not a remotely authenticated
  proxy;
- restarting Vite clears per-tab proxy state and requires the browser to apply
  its safe persisted settings again.

## Alternatives rejected

- **One process-wide mutable runtime:** tabs race and can reuse another tab's
  target/token.
- **Put the identifier or bearer in persistent local storage:** expands secret
  lifetime and makes tabs share state again.
- **Serialize body reads inside one FIFO:** a slow client can head-of-line block
  all later mutations.
- **Treat the identifier as authentication:** any same-origin script can observe
  and reuse its own identifier; loopback and same-origin checks remain required.
