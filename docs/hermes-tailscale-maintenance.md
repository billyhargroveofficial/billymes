# Hermes private-Tailscale maintenance

This branch deliberately contains no Desktop redesign. The production Mac app
is pinned to the known-good Hermes Desktop 0.17.0 bundle and connects through:

```text
Hermes Desktop -> http://127.0.0.1:9119
               -> SSH local forward over Tailscale
               -> mujik 127.0.0.2:9119
```

The branch keeps only the narrow backend Host/Origin allowlist needed when an
operator-configured `dashboard.public_url` host differs from the loopback bind.
Unknown Host headers remain rejected.

## Source updates

Check remote state without changing refs or the worktree:

```bash
bash scripts/sync-hermes-fork.sh --check
```

Synchronize `main` from NousResearch, merge it into the maintenance branch,
and atomically push both non-forced refs to the fork:

```bash
bash scripts/sync-hermes-fork.sh
```

Use `--no-push` for a local-only synchronization.

If the checkout intentionally has local edits:

```bash
bash scripts/sync-hermes-fork.sh --stash-dirty
```

The sync script has no Desktop build/install code and never opens or quits the
app. Updating the Linux backend is handled separately by
`~/.local/bin/update-hermes-backend.sh --apply`; its safe default is a
read-only status/health check.
