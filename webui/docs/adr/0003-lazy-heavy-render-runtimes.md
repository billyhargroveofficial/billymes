# ADR 0003: Lazy render runtimes and a split JavaScript budget

Status: Accepted
Date: 2026-08-26

## Context

The desk gained four capabilities that each carry a real runtime: math
rendering in agent Markdown (KaTeX), physics-quality enter/exit animation
(Motion), analytics charts, and three additional routes. A single
`totalJsMaxBytes` ceiling of 900 kB was written when the application shipped
markdown-only, and it cannot distinguish "the first paint got heavier" from
"an optional runtime exists somewhere in the graph".

Refusing math or animation to stay under the old number would trade a real
product capability for a metric. Raising the number without splitting it would
lose the guard that actually matters: what a cold visit downloads before the
desk is usable.

## Decision

Keep the critical path under an explicit, tightened budget and let optional
runtimes live behind lazy boundaries with a larger total ceiling.

```text
entryJsMaxBytes      400000  the entry chunk alone; tightened from 500000
coldStartJsMaxBytes  620000  the entry plus its static import closure
chunkJsMaxBytes      500000  any single chunk, including the Markdown runtime
totalJsMaxBytes     1400000  the whole graph, lazy chunks included
```

`coldStartJsMaxBytes` is new, and it is the number that actually describes a
first visit. The entry budget alone did not: a bundler is free to split an
eagerly imported dependency into its own chunk, which shrinks the entry file
without removing a single byte from what the browser downloads before first
paint. The checker now walks each entry's `imports` closure and sums it
separately, so moving weight out of the entry file no longer buys slack.

Concretely:

- KaTeX, `remark-math`, and `rehype-katex` are imported only by
  `src/shared/ui/MarkdownRenderer.tsx`, which is itself behind `React.lazy`.
  A session that never renders Markdown never fetches them.
- Motion ships through `LazyMotion` with the `domAnimation` feature set and the
  `m` component, so the drag and layout-projection runtimes stay out entirely.
  What remains is still eager — the provider wraps the whole application — and
  it lands in the cold-start budget, not behind a lazy boundary. At the time of
  writing that is 142 kB of the 557 kB cold start.
- Charts are hand-authored SVG inside the `insights` capsule. No charting
  library enters the graph.
- Every route except chat is a lazy import with a nav-hover preload hint.

## Consequences

The cold-start budget fails on a regression that a 900 kB total would have
absorbed silently, and it cannot be satisfied by chunk-splitting alone. The
total budget tolerates optional runtimes but still fails if one becomes
statically reachable from an entry, because the cold-start check runs
independently.

If a future change needs another heavy runtime, the same test applies: it must
be reachable only from a lazy boundary, and neither the entry nor the cold-start
budget may move to accommodate it.

## Alternatives Rejected

**Keep the 900 kB single ceiling and drop the capabilities.** Rejected: it trades
math rendering and animation — both requested product behaviour — for a number
that was calibrated against a markdown-only application.

**Raise only `totalJsMaxBytes` and leave the entry budget at 500 kB.** Rejected:
the guard that matters is what a cold visit downloads. Raising the total while
leaving the entry limit slack would let a regression move weight into the entry
chunk without failing anything.

**Adopt a charting library (Recharts, visx, Chart.js).** Rejected: the smallest
credible option is comparable in size to everything else added here combined, and
it would still need per-chart overrides to match the desk's tokens and both
themes. Hand-authored SVG in the `insights` capsule costs no bundle bytes and
carries the theme variables directly.

**Ship KaTeX eagerly to avoid a first-render delay on math.** Rejected: it would
put roughly 280 kB of JavaScript in front of a chat screen that usually shows no
math at all. The renderer is already behind `React.lazy`, so the cost lands on
the first Markdown render instead of on startup.
