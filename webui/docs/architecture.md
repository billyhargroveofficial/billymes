# Architecture

Status: current architecture contract after the feature-capsule reorganization.

`billymes-webui` is a Vite/React UI with a deliberately small set of
ownership boundaries. The source tree is the implementation; the root
`architecture.json` and its fail-closed checker are the machine-readable
contract for ownership and dependency drift.

## Lanes and dependency direction

```text
src/app/                 composition root
  ├── src/features/*/    feature capsules
  └── src/shared/*/      feature-neutral reusable code

server/                  gateway forwarding boundary
  gateway-proxy.ts       Vite orchestration and public plugin surface
  gateway-runtime.ts     runtime validation, identity, and bounded registry
  gateway-control.ts     same-origin control, body limits, and mutation FIFO
  gateway-forwarding.ts  HTTP/WebSocket forwarding and header hygiene
architecture.json        ownership/dependency declaration
```

The intended dependency direction is:

```text
src/app  ───────►  src/features/*  ───────►  src/shared/*
   │                    │                       │
   └────────────────────┴──────────────────────┘
                    (shared is the leaf)

server/{serve,gateway-proxy}.ts ───► server/gateway-{runtime,control,forwarding}.ts
                                      │
                                      ▼
                              configured Hermes gateway
```

`src/shared` must not import `src/features` or `src/app`. A feature may use
shared API, libraries, theme, and UI primitives, but consumers should depend on
the feature's public `index.ts`, not its private implementation files. The app
shell composes features and owns cross-feature routing/provider wiring.

## App shell

`src/app/` owns only application composition:

- entrypoint and provider order;
- route registry, redirects, and navigation metadata;
- shell/layout composition;
- application-wide styles and theme mounting.

Business behavior belongs in a feature capsule or a genuinely reusable shared
module. Do not move product behavior into the shell just because a route is
declared there.

## Feature capsules

Each feature under `src/features/` has this minimum public contract:

```text
src/features/<feature>/
  module.json      machine-readable ownership metadata
  index.ts         narrow public entrypoint
  ...              private implementation
```

The feature set is `chat`, `gateway`, `model-selection`, `catalog`, `models`,
`providers`, `insights`, `memory`, `profile-management`, and `profiles`. `profiles` owns the always-mounted profile
scope; `profile-management` owns the lazy administration route so route code is
not forced into the entry bundle. A capsule may add a local `README.md` or `AGENTS.md`
only when it has a real public invariant or product hazard that cannot be
expressed clearly at the root. The chat and gateway capsules have such local
contracts: [chat hazards](../src/features/chat/AGENTS.md) and
[gateway security](../src/features/gateway/AGENTS.md), with their public shapes
in the corresponding `README.md` files. Do not create documentation files for
empty ceremony.

### Route ownership and settings

- `/tools` is owned by `catalog` and lists profile-scoped native Hermes
  toolsets, not MCP servers. It reuses the Skills master-detail composition:
  desktop detail is inline and narrower viewports use a Sheet. Detail owns the
  tool list, provider readiness and key state, automation operations, and any
  provider model catalog exposed by Hermes.
- `/mcp` is a separate `catalog` master-detail surface for MCP server transport,
  enable/test controls, and published tools. Connection metadata is redacted
  before presentation; authentication is shown only as configured state.
- `/profiles` is owned by `profile-management`. It is the only surface that
  assigns the main profile model and exposes reasoning/service-tier controls
  only when the selected model advertises the corresponding capability.
- `/models` is a read-only model and auxiliary-task catalog. It does not mutate
  the profile's main model.
- `/providers` is owned by `providers`. It is the only surface that starts,
  completes, or revokes an OAuth login, edits provider API keys, manages the
  credential pool, and configures custom OpenAI-compatible endpoints. Secrets
  are shown redacted; an unredacted value appears only in direct response to an
  explicit, rate-limited reveal.
- `/insights` is owned by `insights` and is read-only. Its charts are
  hand-authored SVG inside the capsule; no charting library is in the graph.
- `/memory` is owned by `memory`. It reads the profile-scoped learning graph and
  stored memory chunks, and owns memory-backend selection. Its destructive reset
  is guarded behind an explicit confirmation.

These routes share layout primitives and visual tokens; their API ownership and
profile scoping remain feature-local rather than moving into `src/app/`.

`module.json` describes ownership for the architecture checker. When a route,
API surface, dependency edge, or public export moves, update the module contract
and the implementation together, then run:

```bash
pnpm check:architecture
pnpm check:repo-map
```

The checker must fail closed on unknown owners, duplicate ownership, illegal
edges, or stale declarations. Do not add a writable “known debt” baseline to
hide a structural violation.

## Shared and gateway boundaries

`src/shared/` is intentionally domain-neutral:

- `api/` owns typed HTTP/API transport contracts and error handling;
- `lib/` owns small reusable utilities;
- `theme/` owns theme state and tokens;
- `ui/` owns reusable UI primitives and their interaction semantics, including
  the page chrome (`page.tsx`), the loading-placeholder layer (`skeleton.tsx`),
  and the motion policy (`motion/`).

Every async surface renders a skeleton from `shared/ui/skeleton` rather than a
bare loading string, and animation goes through `shared/ui/motion`, whose
provider sets `reducedMotion="user"` once for the whole application. Hover and
selection use the `row-interactive` / `card-interactive` helpers in
`src/app/styles/index.css`; features must not invent a parallel treatment.

The server-side gateway modules own forwarding between the local development
or production loopback server and the configured Hermes gateway.
`gateway-proxy.ts` provides the shared request/upgrade boundary used by Vite;
`serve.mjs` is the production loopback wrapper. Runtime state and validation,
control requests, and HTTP/WebSocket forwarding live in their focused modules.
Production deliberately does not expose the development control route
(`/__mes/gateway` returns `404`). Before proxying, it requires an access key,
issues a signed HttpOnly session, and dynamically mints a short-lived gateway
token from its external systemd environment configuration.
Feature code should not duplicate proxy logic, attach credentials to ad-hoc
requests, or create independent WebSocket lifecycles. The fail-closed checker
also applies the production TypeScript line limit to the configured `serverRoot`
(`server/`) in addition to the source tree.

Mutable proxy runtime is partitioned by one cryptographically random identifier
per browser JavaScript realm/tab. HTTP and control requests carry it in
`X-Mes-Runtime`; WebSocket handshakes carry it in `__mes_runtime`. The proxy
validates and removes both values before upstream forwarding. Its bounded,
TTL-based registry keeps origin, Host, token, mutation sequence, and FIFO state
per identifier; pending controls and active WebSocket leases cannot be evicted.
A lease release is idempotent, so one aborted control cannot release another
request's reservation. A missing identifier may use
configured defaults only for read-only HTTP, while control/upstream mutations
and WebSockets fail closed. Tokens are bound to canonical origin + Host, and
changing either clears the prior token.

The runtime identifier is state partitioning, not authentication. The supported
security boundary remains loopback peer + loopback Host + same-origin browser
metadata. See [ADR 0002](adr/0002-gateway-runtime-isolation.md) and the
[gateway security contract](../src/features/gateway/README.md).

The exact endpoint behavior remains defined by source and tests. This document
does not invent an API schema or claim that a runtime surface exists merely
because a path is mentioned in this document.

## Change protocol

1. Identify the current owner and its public entrypoint.
2. Make the smallest change inside that boundary.
3. Update `module.json`, `architecture.json`, route metadata, or docs when the
   stable contract changes.
4. Run focused tests and the fail-closed architecture checks.
5. Run [`pnpm quality`](development.md#verification) before handoff.

For a durable architectural choice, add an ADR using the format in
[`adr/README.md`](adr/README.md). For a normal task, keep temporary evidence in
the active task plan rather than this document.
