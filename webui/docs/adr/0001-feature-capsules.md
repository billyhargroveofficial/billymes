# ADR 0001: Feature capsules for the application UI

Status: Accepted
Date: 2026-08-26

## Context

The UI is a single Vite/React application with several product surfaces: chat,
gateway configuration, model selection, catalog data, models, and profiles. A
flat source tree makes it easy for route composition, API calls, and feature
behavior to become coupled. A heavyweight multi-package or backend monorepo
would add ownership machinery that this application does not need.

We need a boundary that is explicit enough for an agent and a fail-closed
checker, while remaining cheap to navigate for a small frontend.

## Decision

Organize the UI into an app shell, feature capsules, shared modules, and one
gateway proxy boundary:

```text
src/app/                 composition: entrypoint, providers, router, shell, styles
src/features/<name>/     behavior + module.json + public index.ts
src/shared/              feature-neutral api, lib, theme, and ui
server/gateway-proxy.ts  gateway forwarding boundary
architecture.json        machine-readable ownership/dependency contract
```

The feature capsules are `chat`, `gateway`, `model-selection`, `catalog`,
`models`, `profile-management`, and `profiles`. The profile runtime and its lazy
administration route are separate capsules so provider code can stay in the
entry graph without pulling the whole route into it. The app shell composes them; features own
their private behavior and expose only supported public exports; shared code
does not import feature internals. `architecture.json` and its checker reject
unknown ownership, duplicate ownership, and illegal dependency edges rather
than accumulating an implicit debt baseline.

Local `README.md`/`AGENTS.md` files are optional and reserved for a concrete
feature invariant or hazard. The decision does not define endpoint schemas,
deployment infrastructure, or visual redesign details.

## Consequences

Positive:

- ownership is visible in the path and machine-readable metadata;
- agents can make focused changes without scanning the entire app;
- cross-feature coupling is detected at the boundary;
- the app can grow without immediately becoming a workspace monorepo;
- API/WebSocket and proxy lifecycle remain explicit shared/server concerns.

Costs and obligations:

- moving a public surface requires updating `index.ts`, metadata, and checks;
- the architecture checker and repo map must stay synchronized with source;
- extracting shared code requires proving that it is genuinely feature-neutral;
- route composition remains an app-shell responsibility even when a feature owns
  the page behavior.

## Alternatives rejected

- **Keep one flat `src/` tree:** low short-term ceremony, but ownership and
  cross-feature coupling remain implicit.
- **Create a package/workspace per feature:** stronger isolation than needed for
  this UI and a disproportionate install/build/tooling cost.
- **Put all behavior in `src/app/`:** makes the shell a business-logic hub and
  prevents independent feature verification.
- **Use a broad shared barrel:** hides dependency direction and makes accidental
  coupling difficult for a fail-closed checker to detect.
