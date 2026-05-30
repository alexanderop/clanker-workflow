# @workflow/cli

Command-line interface for the workflow engine.

## Test commands

- `pnpm test` — unit suite (free, deterministic). All e2e describe blocks are skipped.
- `pnpm test:e2e` — runs `WORKFLOW_E2E=1 vitest run --project e2e` against whatever harnesses
  are installed on PATH; adapters not present are auto-skipped at the `it` level. Costs tokens.
  Uses the cheapest path: one schema-bearing agent call per adapter, then a resume that is a
  cache hit with no new spawn.

## Bundled example workflows

Two workflows ship bundled and are resolvable by name without a path:

- `workflow deep-research --args '{"question":"..."}'`
- `workflow vue-newsletter --args '{"topic":"..."}'`

These correspond to `examples/deep-research.ts` and `examples/vue-newsletter.ts` in the package.
