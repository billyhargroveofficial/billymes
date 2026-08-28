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
4. refreshes scoped Node workspaces and rebuilds Dashboard assets when their
   manifests or sources changed;
5. performs read-only remote preflight and pre-syncs the live environment with
   `uv sync --locked --inexact --no-install-project` (so Telegram, Anthropic,
   and other lazy extras are retained without pointing the live editable
   install at a temporary worktree), activates only the tested named branch
   without a detached-HEAD window or `git reset`, then finalizes its editable
   install from the stable production checkout;
6. drains/restarts every enabled Hermes gateway profile plus serve and the
   Tailscale dashboard proxy, verifies new PIDs, and checks each configured
   HTTP health URL;
7. only after the live deployment is healthy, mirrors `origin/main` and
   publishes `origin/billy/production` with exact `--force-with-lease` guards.

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
