---
title: "Bundled workflow scripts run in a vm sandbox with no imports, no zod, no Date.now/Math.random"
date: 2026-05-30
track: knowledge
category: architecture-patterns
problem_type: "sandbox_execution_model"
module: "core"
component: "sandbox"
tags: ["sandbox", "vm", "workflow-scripts", "zod", "determinism", "bundled-workflows", "examples"]
applies_when: "authoring or loading workflow scripts (examples/*.ts, saved workflows) that the engine runs via the core sandbox"
---

# Bundled workflow scripts run in a vm sandbox with no imports, no zod, no Date.now/Math.random

## Context

`@workflow/core` executes workflow scripts (the `examples/*.ts` bundled workflows, plus saved
project/personal workflows) through `runInSandbox` in `packages/core/src/sandbox.ts`. The script
text is transformed with esbuild and run with `new vm.Script(...).runInContext(context)`. This is
**not** an ES module loader: there is no module resolution, and the only things a script can touch
are the globals injected into the vm context.

This shaped how Plan 4b's bundled workflows (`examples/deep-research.ts`,
`examples/vue-newsletter.ts`) had to be written, and why the opt-in e2e suite drives the engine a
particular way.

## Guidance

A workflow script may use ONLY these injected globals (see the sandbox's globals object):
`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`, `budget`, plus a curated set
of built-ins: `Promise`, `JSON`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Error`,
`console`. (`Set`, `Map`, `RegExp` resolve from the realm and are usable.)

Hard rules for any script the sandbox will run:

- **No `import` / `require`.** There is no module context. In particular **`zod` is not available**,
  so a script cannot build a `z.ZodType` to pass as `agent(prompt, { schema })`. Structure output
  via the prompt and parse the returned text instead.
- **No `Date.now()`, no argless `new Date()`, no `Math.random()`.** The sandbox installs
  sentinel-throwing `Date`/`Math` (the determinism guard). Index slicing, string parsing, `Set`
  dedup, etc. are all fine.
- Must `export const meta = { name, description, phases }` as the first statement; top-level
  `await` and a trailing `return` are supported (the body is wrapped in an async IIFE).
- `args` is the parsed `--args` JSON (or `null`). Guard for missing fields.

Corollary for tests: a **schema-bearing agent cannot be expressed in a sandbox script**. The
Plan 4b e2e (`packages/cli/src/e2e.e2e.test.ts`) therefore drives the engine via `createRuntime`
directly (where `z` is available in normal TS) rather than through `runWorkflow(source)`. That is
still the real engine path — `runWorkflow` is a thin wrapper over `createRuntime` + the sandbox
loader.

The `examples/` package intentionally ships **no `build`/`typecheck` scripts**: the scripts
reference undefined globals (`agent`, `parallel`, …) and would fail `tsc`. They are read as source
strings at runtime, and vitest's globs (`packages/*/src/**`) don't pick them up. Oxlint scans them
but only flags syntax/pattern rules, not undefined-variable errors, so they stay lint-clean.

## Why This Matters

Writing a bundled workflow that `import { z } from "zod"` or calls `Date.now()` looks correct and
type-checks in isolation, but throws `SandboxViolation` (or a module-not-found) the moment the
engine runs it — a failure that only surfaces at execution time, not at build/test time, because
the examples aren't compiled or unit-tested. Knowing the execution model up front avoids shipping a
workflow that can never run.

## When to Apply

- Adding or editing anything under `examples/` (bundled workflows).
- Writing saved workflows resolved by name (`.workflow/workflows/*`, `~/.workflow/workflows/*`).
- Writing tests that need a schema-bearing agent (use `createRuntime` directly, not a sandbox script).

## Examples

Verify a bundled workflow actually runs before assuming it's correct — load the source string and
run it through the built engine with a scripted runner (no model, no tokens):

```js
import { readFileSync } from "node:fs";
import { runWorkflow } from "<repo>/packages/cli/dist/index.js";
import { createJournal } from "<repo>/packages/core/dist/index.js";

const ok = (value) => ({ isOk: () => true, isErr: () => false, value }); // minimal neverthrow Ok
const source = readFileSync("<repo>/examples/deep-research.ts", "utf8");
const runner = {
  id: "s",
  capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: false },
  async run(req) {
    let text = "a\nb";
    if (req.label?.startsWith("scope")) text = "x\ny";
    else if (req.label?.startsWith("verify")) text = "REAL";
    return ok({ text, data: undefined, usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [] });
  },
};
const r = await runWorkflow({
  source, args: { question: "q?" }, runner, runId: "s", cwd: "/tmp",
  concurrency: 8, maxAgents: 1000, budgetTotal: null,
  journal: createJournal(), emit: () => {}, now: () => 0,
});
console.log(r.isOk(), r.isOk() && r.value.returnValue); // true { question, confirmedCount, ... }
```

This catches `SandboxViolation` and module-not-found errors that the build/test pipeline cannot.

See also [[vitest-monorepo-build-and-filter-quirks]] for why the engine must be built before such a
script (or the e2e tests) can import the cross-package `dist`.
