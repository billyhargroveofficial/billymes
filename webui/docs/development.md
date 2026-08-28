# Development workflow

This is a package inside the Billymes source tree. Use Node.js 24–26 and pnpm
11; no remote login, SSH forwarding, or credential-mint workflow is part of
the package.

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

`pnpm dev` invokes loopback Vite through `npx`. It can proxy to a deliberately
provided local gateway, but it must never create tunnels, alter runtime files,
or mint/store secrets. Keep environment values outside the repository.

## Production integration

The checked-out `webui/` source and `dist/` are the runtime; do not deploy a
copied standalone directory. `server/serve.mjs` serves the SPA and proxies API
and WebSocket requests on loopback. Its unit template uses:

```text
WorkingDirectory=%h/.hermes/hermes-agent/webui
EnvironmentFile=%h/billymes-ui/env
```

Create and maintain the external environment file with mode `0600`. It contains
`ACCESS_KEY_SHA256`, `SESSION_SECRET`, gateway target, and token-mint
configuration, but source, tests, logs, and docs may not. The production server
uses that hash to issue signed HttpOnly sessions at `/__access`; it mints its
own short-lived gateway token only for authorized API/WebSocket requests. The
production server deliberately has no `/__mes/gateway` control plane; the
browser's local mode accepts its `404` as a fixed same-origin runtime.

`scripts/billymes-update` owns build/restart/health orchestration. Update it
with this package when the production integration changes; do not introduce a
second deploy script.

## Verification

Run focused tests for proxy lifecycle changes, then:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:repo-map
pnpm build
```

Hosted-tool replay tests must retain the event-ledger presentation invariant:
one batched hosted response can render several cards, but those cards remain
hosted records and never trigger an extra tool call.
