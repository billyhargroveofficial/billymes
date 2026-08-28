# Chat feature contract

This file records hazards that are easy to miss when changing the chat runtime.
Read the root [`AGENTS.md`](../../../AGENTS.md) and
[the feature README](README.md) first.

## Profile and session generations

- `ChatRuntimeProvider` is profile-scoped. `ProfileChatRuntime` is keyed by the
  active profile, so changing profile intentionally creates a fresh
  profile-specific controller and session selection.
- `openGeneration` guards the asynchronous history/detail/resume work started by
  `openSession`. `operationGeneration` guards stale send failures. Increment the
  appropriate generation whenever a new session/open operation supersedes old
  work; never let an old result overwrite the current profile/session.
- Gateway events are accepted only for the active profile and selected live or
  history session. Preserve this filtering when adding event types.

## Persistent controller and UI unmount

`ChatRuntimeProvider` is mounted by `src/app/providers/AppProviders.tsx`, above
the route UI. `ChatPage` and its session/inspector sheets are consumers: they may
unmount during route or responsive UI changes without owning the chat controller.
Do not move the persistent controller into `ChatPage` or tie its lifetime to a
single visual surface. Profile changes are the deliberate exception described
above.

The usage polling effect marks itself disposed and clears its interval. The
connection hook removes listeners, cancels a pending retry, and closes its
client on unmount or profile/gateway epoch change. Preserve all cleanup paths.

## Render cost

`ChatRuntimeContext` intentionally carries a fresh value object on every runtime
change, including each streamed token and each composer keystroke. The cost is
contained at the leaves instead: `MessageRow`, `SessionList`, `Inspector`,
`Composer`, and `StatusBar` are `memo`'d, `ChatPage` passes them
`useCallback`/`useMemo`-stable props, and `StatusBar` owns its own one-second
clock so the timer never re-renders the thread. Keep that boundary when adding a
consumer — a new unmemoised child of `ChatPage`, or an inline arrow passed to a
memoised one, silently re-renders the whole thread on every token.

The thread additionally renders only the tail of the message list
(`THREAD_WINDOW` in `ChatPage`); older rows mount on explicit request and the
scroll anchor is preserved manually. Do not switch the thread back to rendering
the full list — long sessions run to hundreds of markdown-heavy rows.

## Reconnect and interrupt

- `useGatewayConnection` obtains a fresh WebSocket ticket and reconnects with
  bounded exponential backoff (capped at 15 seconds). It must not reconnect
  after disposal or run concurrent connection attempts.
- `GatewayClient` generation checks prevent events from a replaced socket from
  reaching the current runtime. Keep that guard intact when changing socket
  lifecycle code.
- A request written to a socket and then disconnected is `uncertain`, not
  safely retryable. Never automatically resend `prompt.submit`; resume the
  session, replay `session.events.since`, and let durable history determine
  whether it was accepted. Busy state remains active across a disconnect until
  resume reports the terminal state.
- Replay is cursor-based, never content-based. Gateway `durable_seq` reports
  successful persistence; `replay_base_seq` is the prefix safe to omit after
  hydration or explicit supersession of an old ephemeral terminal. Read that
  atomic snapshot before refreshing REST, advance the watermark only to its
  replay base, then apply the protected current tail and concurrently buffered
  live frames through `acceptGatewayEvent`.
- A reconnect recovery owns a unique generation token in addition to the
  session id. Cleanup from a stale same-session attempt must not clear or
  release the current attempt's live buffer. Baseline convergence is bounded;
  a truncated post-refresh gap or unstable cursor must fail without claiming
  unseen `latest_seq` events.
- `stop()` sends `session.interrupt` for the active live session and clears the
  local busy state. `newChat()` invalidates stale generations and best-effort
  interrupts a busy previous session. Closed/error states must leave the UI
  usable for a later reconnect.

## Durable history and hosted cards

- History uses chronological pages of at most 500 rows. The REST
  `pagination.user_turn_offset` is the number of visible user turns before the
  returned page. Store the offset of the oldest loaded page and re-merge the
  full cached presentation ledger after prepending older rows.
- `session.presentation.list` is display-only and bounded to 256 cards. A
  provider batch remains several cards with stable order and non-zero provider
  durations, while the transcript keeps zero synthetic function/tool rows.
- REST history may carry `interim_messages` on a canonical assistant row. They
  are server-derived semantic commentary segments (never text heuristics) and
  reconstruct immediately before that row's final content, so the durable
  order stays commentary → hosted cards → final after F5.
- Live `tool.start`/`tool.complete` events are the fast path. Every terminal
  `message.complete`, `turn.end`, or `error` also performs a generation-guarded
  ledger reconciliation so one lost WebSocket lifecycle frame repairs itself
  before F5 without resubmitting the hosted call.
- Reducer order is `interim commentary -> tools -> final`. A final response
  after an interim segment starts a fresh assistant segment; a cold replay must
  reproduce that same order and deduplicate cards already received live.

## Focused tests

When changing this feature, maintain focused deterministic tests for:

- stale profile/session history, detail, resume, and send results;
- event filtering by profile and selected session;
- controller persistence when `ChatPage` unmounts and remounts;
- retry cancellation, socket replacement, and cleanup on unmount;
- durable replay/REST alignment, epoch reset, active-tail retention,
  same-session reconnect generations, truncation, and bounded convergence;
- `stop()`/`newChat()` interrupt behavior and busy-state recovery.

Tests must not open SSH, mint a token, contact a real Hermes gateway, or print
credential-bearing data. Finish with the canonical commands in the root contract.
