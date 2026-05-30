# Documented Solutions

Knowledge store of past problems and learnings, by category, with YAML frontmatter
(`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
This index is normally rebuilt automatically when solution files change.

## architecture-patterns

- [Bundled workflow scripts run in a vm sandbox with no imports, no zod, no Date.now/Math.random](architecture-patterns/workflow-sandbox-script-constraints.md) — what globals a workflow script may use, and why schema-bearing agents can't run in-sandbox.

## developer-experience

- [Build before pnpm test, and don't use pnpm --filter to run vitest in this monorepo](developer-experience/vitest-monorepo-build-and-filter-quirks.md) — the two test-harness gotchas on a fresh checkout/worktree.
