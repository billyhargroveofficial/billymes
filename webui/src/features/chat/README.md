# Chat

The chat capsule owns profile-scoped session history, live streaming events,
runtime usage, prompt submission, interruption, and the chat screens.

## Public surface

Consumers use [`index.ts`](index.ts). It exports only `ChatRuntimeProvider` and
`ChatPage`. The runtime hook, chat/session types, history reconstruction,
reducer details, socket wiring, and UI subcomponents stay private unless a
cross-feature contract requires a deliberate export.

The capsule declares its cross-feature dependencies in
[`module.json`](module.json): gateway transport, model selection, and profile
scope.

## Current shape

```text
chat/
  api/chat-api.ts                 REST session/history operations
  model/ChatRuntimeProvider.tsx   persistent profile-scoped controller
  model/use-gateway-connection.ts ticket, socket, reconnect lifecycle
  model/chat-history.ts           history reconstruction
  model/chat-reducer.ts           streaming event reduction
  model/session-utils.ts          session grouping and usage helpers
  ui/ChatPage.tsx                 route UI and composition
  ui/SessionList.tsx              session selection UI
```

`ChatRuntimeProvider` is composed in `src/app/providers/AppProviders.tsx`, above
`src/app/router/AppRouter.tsx`. The route UI can unmount while the controller
remains alive; a profile change remounts the keyed profile runtime by design.

## Runtime invariants

### Profile and session isolation

The active profile scopes queries, session creation, history, and events. Event
handlers reject events for another profile or for a session that is neither the
selected live session nor the selected history session.

Asynchronous session opening uses `openGeneration` to discard stale history,
detail, and resume results. Prompt submission uses `operationGeneration` so a
superseded send cannot restore draft/error state over a newer operation. New
session/open actions must advance the relevant generation before awaiting work.

### Persistent controller, replaceable UI

The provider owns the controller state while `ChatPage`, the session list, and
inspector sheets are replaceable views. UI unmount must not leak timers,
listeners, or a WebSocket, and must not move persistence into a page component.
The connection hook and usage polling effect own their cleanup.

### Reconnect and interruption

The connection hook obtains a WebSocket ticket, prevents concurrent attempts,
retries with bounded backoff, and cancels retries when disposed. Socket
generation checks ignore events from replaced connections. A closed/error state
clears the local busy indicator while leaving REST history usable.

`stop()` requests `session.interrupt` for the active live session. `newChat()`
invalidates stale asynchronous work, resets local state, and best-effort
interrupts a busy previous session. Do not silently remove the interrupt path
or make a failed interrupt strand the composer in a busy state.

## Verification focus

Add or update focused tests whenever these invariants change. At minimum cover
generation guards, profile/session event filtering, controller cleanup across UI
unmount, reconnect cancellation/socket replacement, and interrupt recovery.
Use the canonical repository checks from [`docs/development.md`](../../../docs/development.md)
after focused tests. Never use a real gateway, SSH tunnel, token mint, or
`.env.local` in the test suite.
