# Claude Code instructions for Billymes

@AGENTS.md

`AGENTS.md` is the authoritative, complete instruction set for this repository
and is imported above so Claude Code receives the same rules as Codex and other
coding agents. Read it in full before taking action, with the **Billymes fork
overlay** taking precedence over generic upstream workflow text.

In particular, do not mistake this for a disposable upstream checkout: it is
the live `billy/production` source tree. Read `OWNED_PATCHES.md`, preserve the
`origin/main` mirror policy, release through `billymes-update`, and preserve the
provider-hosted semantics described in the hosted-tool contract. The known
reload defect is a missing presentation-event persistence/replay layer; fake
function calls or synthetic tool-result transcript rows are explicitly not an
acceptable fix.
