---
title: "Build before pnpm test, and don't use pnpm --filter to run vitest in this monorepo"
date: 2026-05-30
track: knowledge
category: developer-experience
problem_type: "test_harness_quirk"
module: "monorepo-root"
component: "vitest"
tags: ["vitest", "turbo", "pnpm", "monorepo", "test-harness", "build", "e2e", "workspace"]
applies_when: "running the test suite or a single package's tests in this pnpm + Turbo monorepo"
---

# Build before pnpm test, and don't use pnpm --filter to run vitest in this monorepo

## Context

Two non-obvious test-harness behaviors cost time on a clean checkout / fresh worktree of this
repo. Both look like real failures but are harness mechanics.

## Guidance

**1. Run `pnpm build` before `pnpm test` on a fresh tree.** `pnpm test` is `vitest run`, which runs
both the `unit` and `e2e` vitest projects (see `vitest.workspace.ts`). Unit tests resolve
intra-package via relative `./foo.js` imports, but the `*.e2e.test.ts` files import sibling
packages by name (e.g. `@workflow/schema`), which resolves to that package's `dist/` (its
`exports` point at `./dist/index.js`). On a tree that hasn't been built, ~20 e2e files fail to
collect with:

```
Error: Failed to resolve entry for package "@workflow/schema". The package may have
incorrect main/module/exports specified in its package.json.
```

This is expected, not a bug — `turbo run build` first, then `pnpm test` is green. (Turbo caches the
build, so it's cheap on subsequent runs.)

**2. Don't run a single package's tests with `pnpm --filter`.** Because the vitest workspace
include globs are rooted at the monorepo root (`packages/*/src/**/*.test.ts`), running
`pnpm --filter @workflow/core exec vitest run` reports **"No test files found"** — the filtered cwd
doesn't match the root-anchored globs. Instead run from the repo root and pass a path filter:

```bash
pnpm exec vitest run packages/core        # one package's tests
pnpm exec vitest run packages/cli         # ...
```

## Why This Matters

Both symptoms read as "the build/tests are broken" to someone (or an agent) who just cloned or
created a worktree. They send people debugging package `exports` or vitest config that are actually
correct. Knowing the order (build → test) and the correct single-package invocation avoids the dead
end entirely.

## When to Apply

- First test run in a new clone or `git worktree` before anything is built.
- Iterating on one package's tests during TDD (use the path-filter form, not `--filter`).
- Wiring CI or pre-commit hooks that run tests (ensure a build step precedes the e2e project).

## Examples

```bash
# Fresh worktree, baseline check:
pnpm install
pnpm build                          # REQUIRED first — e2e files import cross-package dist
pnpm test                           # green: unit + e2e (e2e bodies skip without WORKFLOW_E2E=1)

# TDD on a single package:
pnpm exec vitest run packages/core  # NOT: pnpm --filter @workflow/core exec vitest run
```

See also [[workflow-sandbox-script-constraints]].
