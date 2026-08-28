# Billymes patch stack

`billy/production` is the maintained Hermes deployment branch for the
`billyhargroveofficial/billymes` fork. It carries a small patch series on top
of `NousResearch/hermes-agent:main` while keeping the fork's `main` branch as
an exact upstream mirror.

## Remote and branch policy

```text
upstream/main             NousResearch/hermes-agent
origin/main               clean mirror of upstream/main
origin/billy/production   tested owned patch stack
```

Do not commit owned changes to `main`, and do not run `hermes update` from
`billy/production`. The stock updater targets `origin/main`; it is intended
for unmodified managed checkouts and is not the deployment gate for this
fork.

Use `scripts/billymes-update --check` to inspect upstream drift and
`scripts/billymes-update` to update. The updater:

1. refuses a dirty or incorrectly checked-out tree;
2. creates a `mktemp` Git worktree and rebases only that staging branch onto
   `upstream/main`; rebase cleanup removes the temporary worktree and branch;
3. always creates a locked staging environment with the `all`, `dev`,
   `messaging`, and `anthropic` extras, then runs the focused regression suite
   there, forcing the editable root package to resolve to that worktree before
   running local and remote code-kernel tests;
4. refreshes scoped Node workspaces, then installs/tests/builds the in-tree
   `webui/` package with its pinned pnpm version when that source changes;
5. performs read-only remote preflight and pre-syncs the live environment with
   `uv sync --locked --inexact --no-install-project` (so Telegram, Anthropic,
   and other lazy extras are retained without pointing the live editable
   install at a temporary worktree), activates only the tested named branch
   without a detached-HEAD window or `git reset`, then finalizes its editable
   install from the stable production checkout;
6. installs the tracked WebUI user-service unit, then drains/restarts every
   enabled Hermes gateway profile plus serve, the Tailscale dashboard proxy,
   and `billymes-ui.service`, verifies new PIDs, and checks each configured
   HTTP health URL (including the WebUI health URL);
7. only after the live deployment is healthy, mirrors `origin/main` and
   publishes `origin/billy/production` with exact `--force-with-lease` guards.

An unpublished local production commit is accepted only as a strict
fast-forward of the exact remote production SHA observed by preflight. The
updater fetches that remote ref and verifies ancestry before validation and
activation; a divergent, remote-only, or independently moved revision is still
rejected. Do not pre-push a candidate to bypass this transaction boundary.

Before local activation the updater writes a private receipt in the Git common
directory. If interruption happens after activation but before both pushes
finish, the next run revalidates the recorded revision, restores service
health, and resumes only the recorded leases. The receipt is removed after
successful publication. A rebase conflict, failed staging gate, or failed
build leaves the live branch and fork unchanged; a post-activation failure
leaves the tested local revision active and recoverable. `--no-push` always
stops after the green staging gate and never deploys or restarts services.

## Patch lifecycle

Keep one independently reviewable commit per behavior. When upstream accepts
an equivalent fix, drop the corresponding owned commit during the next rebase
instead of carrying both implementations. Machine configuration, profiles,
OAuth state, service units, tokens, and runtime databases stay outside Git.

Before publishing a new owned commit:

```bash
git diff --check upstream/main...HEAD
scripts/billymes-update --test
```

Never publish the local `safety/*` branches. They are recovery snapshots for
this machine, not part of the public fork.

## WebUI ownership

The WebUI lives in `webui/` in the main fork. There is no standalone WebUI
repository or copied runtime to synchronize. The production service executes
that source tree and reads only its external `0600` environment file at
`%h/billymes-ui/env`; the tracked unit template and updater are the integration
contract. Keep hosted Responses calls presentation-only through the event
ledger, including batch fan-out, terminal-turn reconciliation, and reload
replay. Never solve a UI reload by adding synthetic provider/tool messages to
the Hermes transcript.

Intermediate Codex commentary is already durable inside the canonical
assistant row's Responses sidecar. History endpoints expose only its semantic,
redacted `interim_messages` display projection and strip raw provider replay
fields (`api_content`, `reasoning_details`, and `codex_*`); the WebUI restores
those stable segments before the hosted-card segment
and final response. Do not persist duplicate commentary rows, weaken the
profile display gates, or replace provider ids with content matching.

## Native Codex and replay ownership

The production stack includes the fork's native Codex OAuth transport. It
keeps a per-conversation Responses WebSocket, uses `previous_response_id` only
for a verified continuation, selects the lite wire from authenticated catalog
metadata, keeps hosted-tool requests on classic Responses, and falls back to
HTTP/SSE without replaying potentially started hosted work. The `codex-native`
web provider is bundled in this repository; do not recreate the removed
machine-local override.

The WebUI reload boundary is cursor-based. `session.events.since` atomically
returns `durable_seq` for successful persistence and `replay_base_seq` for the
prefix safe to omit after authoritative hydration. Non-durable terminal states
remain replayable until a following `message.start` explicitly supersedes
them. REST hydration aligns to the replay base, while the protected current
tail and concurrent live frames are applied afterward through one sequence
watermark. Preserve generation ownership, current-tail retention, bounded
convergence, and fail-closed behavior for a truncated gap. Content-based
deduplication is not an acceptable substitute.

Active-turn reload has an additional owned boundary. REST can contain an
incrementally persisted portion of the active tail, so resume must be
sent/applied before awaiting a slow history request and replay must be its only
tail owner. The in-flight gateway state carries `history_anchor_display_key`,
an immutable clone-safe key generated from the exact raw display-dedupe
identity of the pre-turn row. It must never be replaced with a database row id,
timestamp, or text matching: compression can clone physical rows and matching
content is legitimate. The history adapter processes `through_display_key`
before pagination and returns an explicit found marker; retain that same
boundary for `load-earlier` until a full unbounded rebase, or disable older
pages while the active boundary is unavailable/unconfirmed. Reject any later
page whose marker says that retained boundary disappeared. A terminal event
still clears active/busy state when its sequence is omitted at the replay base.
Gateway orphan-reap grace is an operational guardrail only; correct resume
ordering is what preserves the turn.

The session picker follows explicit identity transitions. A fresh
`session.create` has no durable database row, so the WebUI invalidates its
catalog after `prompt.submit` settles. Compression rotates only the durable
key; `session.identity` is a sequenced/replayable previous-to-current edge that
the selected client applies atomically. Do not replace either rule with list
polling, title matching, or a guessed root/tip mapping.
