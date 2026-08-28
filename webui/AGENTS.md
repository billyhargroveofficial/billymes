# WebUI ownership

`webui/` is owned by the main Billymes fork. It is not a standalone clone: do
not add a nested `.git`, import another repository history, or keep a copied
runtime directory outside this source tree.

Use `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm build`. `pnpm dev`
is loopback-only and must remain free of SSH, token minting, and other personal
machine assumptions. Production runs `server/serve.mjs` through the tracked
systemd template; runtime values are supplied only by `%h/billymes-ui/env`
(mode `0600`), never by tracked source.

`server/` owns the gateway proxy lifecycle. Each control or WebSocket lease
must be released exactly once, and client/upstream close paths must tear down
their peer. `/__mes/gateway` is development-only; the production wrapper must
continue returning `404` so local same-origin runtime remains valid. Production
is access-key gated: preserve `ACCESS_KEY_SHA256` comparison, signed HttpOnly
`mes_session`, pre-mint API/WebSocket authorization, and dynamic short-lived
gateway-token minting from the external environment.

Chat display is a presentation/replay surface. Preserve the hosted-tool ledger:
batched hosted calls render as individual cards without being converted into
ordinary client tools, duplicated on reconnect, or executed during replay.
`session.presentation.list` is bounded to 256 cards and returns one-based global
turn indices. REST history supplies `pagination.user_turn_offset`; always merge
the complete cached ledger against the oldest loaded page's offset after a cold
reload or older-page prepend. An absent offset is only a compatibility fallback
for an older backend. Do not attach global turn 1 to the first user row of an
arbitrary latest-only page.

History requested with `include_compacted=true` is the selected conversation's
compression-only root-to-tip display lineage. Never fold branches, delegates,
reset continuations, or tool sessions into it. Profile selection applies to the
entire chat data plane: history, ledger, media, upload, list/read/download,
stream, mkdir, and delete must all stay inside the same profile home.
Do not modify chat reducer, `GatewayClient`, or `ChatRuntimeProvider` while
working on the integration boundary without explicit owner approval.
