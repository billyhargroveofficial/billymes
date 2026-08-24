# Hermes private-Tailscale maintenance

This branch deliberately contains no custom Desktop redesign. The production
Mac app is based on official upstream (upstream base `981101239a06`; the
package version still reads `0.17.0`) and connects through:

```text
Hermes Desktop -> http://127.0.0.1:9119
               -> SSH local forward over Tailscale
               -> mujik 127.0.0.2:9119
```

The branch keeps only the narrow backend Host/Origin allowlist needed when an
operator-configured `dashboard.public_url` host differs from the loopback bind.
Unknown Host headers remain rejected.

The Mac deployment is remote-only: there is no managed local Hermes Agent,
Node, or uv runtime under `~/.hermes`. Upstream's connection registry always
contains a synthetic `This device` entry, and background roster enumeration
can request it even while the primary connection is remote. The maintenance
build therefore rejects an auxiliary `bootstrap-needed` result before it can
reach `ensureRuntime()` or the installer. An existing local runtime still
works, and an explicit primary Local setup remains the only path allowed to
own first-run installation.

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
app. The local `~/.local/bin/update-hermes-desktop.sh` wrapper additionally
checks the installed signature, arm64 bundle, approved upstream/maintenance
install stamp, recovery bundle, and the absence of local-runtime artifacts
while keeping the same source-only behavior. Updating the Linux backend is
handled separately by `~/.local/bin/update-hermes-backend.sh --apply`; its
safe default is a read-only status/health check.
