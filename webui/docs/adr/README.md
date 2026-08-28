# Architecture decision records

ADRs capture durable decisions that future code and documentation should be
able to rely on. They are not a changelog, task log, or substitute for tests.

## Index

- [ADR 0001 — Feature capsules](0001-feature-capsules.md) — accepted current
  boundary for app/features/shared ownership.
- [ADR 0002 — Per-tab gateway runtime isolation](0002-gateway-runtime-isolation.md) —
  accepted local proxy state and security boundary.
- [ADR 0003 — Lazy render runtimes and a split JavaScript budget](0003-lazy-heavy-render-runtimes.md) —
  accepted entry/chunk/total budgets and the lazy math and animation runtimes.

## Process

1. Search existing ADRs and [`docs/architecture.md`](../architecture.md) before
   opening a new decision.
2. Use the next free four-digit number.
3. Include `Status`, `Context`, `Decision`, `Consequences`, and
   `Alternatives Rejected`.
4. Link the affected source contract (`architecture.json`, `module.json`, route
   registry, or tests) without duplicating its full contents.
5. If a decision changes, write a new ADR or an explicit dated clarification;
   do not silently rewrite history.

Only decisions that remain useful after the current task belong here. Temporary
alternatives and implementation evidence stay in the task plan or an explicit
loop record.
