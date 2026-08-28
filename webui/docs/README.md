# Documentation index

This directory contains stable architecture contracts, development guidance,
and durable decisions for `billymes-webui`.

## Start here

- [`architecture.md`](architecture.md) — current ownership, dependency direction,
  and gateway boundary.
- [`development.md`](development.md) — local workflow, side-effect boundaries,
  testing, and copy-paste-ready verification commands.
- [`adr/README.md`](adr/README.md) — decision record policy and index.
- [`adr/0001-feature-capsules.md`](adr/0001-feature-capsules.md) — accepted
  feature-capsule architecture decision.
- [`adr/0002-gateway-runtime-isolation.md`](adr/0002-gateway-runtime-isolation.md) —
  accepted local proxy runtime-isolation and token-binding decision.
- [`reviews/README.md`](reviews/README.md) — durable review and remediation
  ledgers, including the inherited implementation audit.

## Documentation policy

`AGENTS.md` and [the rules](../.agents/rules/README.md) are the operating
contract. This directory should contain only behavior or structure that is
stable enough to help future work. The implementation, tests,
[`architecture.json`](../architecture.json), and the fail-closed checker remain
authoritative when prose becomes stale.

Keep active task notes, transient measurements, and unresolved alternatives in
the task plan. Use [`loop-develop/README.md`](../loop-develop/README.md) only
when the user explicitly requests a long-lived goal or handoff.

Never place secrets, real tokens, private host values, or `.env.local` contents
in documentation. Docs-only changes should pass:

```bash
git diff --check
```
