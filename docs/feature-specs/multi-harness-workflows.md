# Feature: Multi-Harness Workflows

> Let a single workflow mix coding harnesses step-by-step — e.g. Copilot (model X) drafts, then Claude Code reviews — with fail-fast validation that every harness it uses is actually available before the run starts.

## Overview

Today `meta.harness` is the single source of truth for the whole run, resolved to one
adapter. The runtime *already* supports per-call overrides (`AgentOptions.adapter` +
`AgentOptions.model`) and reusable `profile()` configs, dispatched via `resolveRunner`
(`runtime.ts:265`) and `buildRunnerMap` (`adapter-select.ts:66`) — so mixing harnesses is
mechanically possible but undocumented and unguarded. The gap is safety and ergonomics:
an unavailable per-call adapter currently **silently falls back** to the workflow default.
This feature keeps `meta.harness` as the run *default*, lets any `agent()`/`profile()`
override it for that step, and adds a fail-fast pre-flight that validates the full harness
set before the first agent runs.

## Goals

- Author can pick a different harness/model per `agent()` step without ceremony.
- `meta.harness` remains the default; a harness declared on an agent primitive overrides it.
- No silent fallback: if a referenced harness isn't installed/buildable, the run refuses to
  start with a clear error (before tokens are spent).
- Zero new `meta` field — the harness set is auto-discovered from the script.
- Documented pattern + a runnable example that mixes harnesses.

## Behaviour & Semantics

- **Default + override:** `meta.harness` is the run default. `agent(prompt, { adapter, model })`
  and `agent(profile, prompt)` (where `profile({ adapter, model })`) override it for that call.
- **Auto-discovery via literal scan:** the engine statically scans the script for every
  harness it references — `adapter:` on `agent()` options and `profile()` configs, unioned with
  `meta.harness`. **Harness values must be string literals** (a `HarnessId`); a computed
  expression (`adapter: someVar`) is a validation error telling the author to use a literal.
  This makes the static scan complete, so fail-fast is total.
- **Fail-fast pre-flight:** before the first agent runs, validate each discovered harness is
  installed (in `deps.adapters.detected`) or buildable (`raw-api` only when a completion fn /
  `ANTHROPIC_API_KEY` is configured). Any missing harness → refuse to start (`WorkflowError`,
  `HarnessNotDeclared`-style) listing what's missing.
- **Model is pass-through:** `opts.model` is forwarded to the chosen adapter's CLI unchanged
  (`req.model` → e.g. `claude.ts:38`, `copilot.ts:38`). No model registry, no validation; the
  CLI rejects bad model names.
- **Determinism preserved:** harness choice is fixed by the script and the per-call request
  already carries `model`; journal replay returns cached results by seq before `runner.run()`
  is reached, so mixing harnesses does not affect resume.

## Implementation Details

Seams that already exist (verified):

- `AgentOptions` — `adapter?: string`, `model?: string` (`packages/core/src/runtime.ts:25–35`).
- Per-call dispatch — `runtime.ts:265`:
  `const runner = opts.adapter ? (deps.resolveRunner?.(opts.adapter) ?? deps.runner) : deps.runner;`
- `buildRunnerMap(detected, cfg, deps)` memoises a runner per candidate adapter and exposes
  `resolveRunner(id)` (`adapter-select.ts:66–81`); wired into `execute.ts:143–145`.
- `profile()` primitive (`packages/workflow/src/index.ts`; core `profile.ts`).

Changes:

1. **Type tightening** — change `AgentOptions.adapter` from `string` to the `HarnessId` literal
   union (`"claude" | "codex" | "copilot" | "raw-api"`) and apply the same to `ProfileConfig.adapter`,
   so editors enforce literals. Update `packages/workflow` re-exports.
2. **Pre-flight scan + validation** — add a static scanner (sibling to `extractMeta()` in
   `sandbox.ts`, or a dedicated module) that parses the workflow source and collects the set of
   `adapter` literals on `agent()`/`profile()` calls. Reject non-literal `adapter` values. Union
   with `meta.harness`. In `run.ts`/`execute.ts`, before dispatch, validate every harness in the
   set against `deps.adapters.detected` (+ raw-api key check); fail fast otherwise.
   - **`--mock`:** skip pre-flight harness validation (consistent with how mock skips the consent
     gate and install checks); all per-call adapters already resolve to the mock runner.
3. **Docs + example** — document the per-call `adapter`/`model` and `profile()` pattern in
   `apps/docs`, and add a runnable example under `packages/examples` (e.g. Copilot drafts →
   Claude reviews) referenced from the docs.

### Edge cases

- `raw-api` referenced per-call but no `ANTHROPIC_API_KEY`/completion fn → pre-flight failure
  (it's not buildable), not a silent fallback.
- Worktree isolation (`opts.isolation: "worktree"`) is orthogonal and works with any harness.
- A harness referenced only inside an unreached code branch is still validated (static scan is
  branch-agnostic) — acceptable and safer (fail-fast).

## Scope

### MVP

- [x] Fail-fast pre-flight validation of the full (literal-scanned) harness set.
- [x] `AgentOptions.adapter` / `ProfileConfig.adapter` tightened to `HarnessId`.
- [x] Docs + runnable multi-harness example.

### Future Enhancements

- [ ] Consent prompt surfaces the full harness set (not just `meta.harness`).
- [ ] Visible event/warning on any harness fallback (largely subsumed by fail-fast).
- [ ] `meta.harnesses[]` explicit declaration (if static scan proves too limiting).
- [ ] Per-harness model registry / validation of model names.
- [ ] Support computed/dynamic harness values (relax the literal-only rule).

## Status

**Status:** Spec Complete
**Created:** 2026-05-30
**Priority:** TBD
