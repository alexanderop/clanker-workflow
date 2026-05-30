# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is **workflow-monorepo** — a deterministic multi-agent workflow engine. A workflow is a TS file
that imports from the `workflow` package and exports a `defineWorkflow({ …, async run() { … } })`
default, orchestrating coding-agent invocations (`agent()`, `parallel()`, `pipeline()`) with durable,
crash-safe execution: every agent result is journaled by sequence number, so a run can be replayed
from a checkpoint without re-invoking the model. Scripts run in a VM sandbox, agents are dispatched
through pluggable harness adapters (Claude/Codex/Copilot CLIs or the raw Anthropic API), and progress
is streamed to a React+Ink terminal UI.

pnpm workspaces (pnpm ≥11), ESM-only, Node ≥20. Packages build with **tsup**, test with **vitest**,
lint with **oxlint**, and git hooks run via **lefthook**.

## Build / Test / Lint

- **Build all packages** (topological): `pnpm build`
- **Type-check**: `pnpm typecheck` — builds first (declarations feed dependent packages), then `tsc --noEmit` per package
- **Lint**: `pnpm lint` (oxlint)
- **Test (unit)**: `pnpm test` — vitest run, the `unit` project
- **Watch tests**: `pnpm test:watch`
- **Run a single test file**: `pnpm vitest run packages/core/src/runtime.test.ts`
- **Filter by test name**: `pnpm vitest run packages/core/src/runtime.test.ts -t "nested"`
- **e2e tests**: `pnpm test:e2e` — sets `WORKFLOW_E2E=1` and runs the `e2e` project (these spawn real agents and use tokens)
- **Run the example workflow end-to-end**: `pnpm example` (builds, then runs `packages/examples/src/haiku.workflow.ts` via the CLI — spawns a real Claude agent)

`lefthook` runs `lint` + `typecheck` on **pre-commit** (parallel) and `test` on **pre-push**.

### Test layout & conventions

Tests are **colocated** with source as `*.test.ts(x)` inside each package's `src/`. The vitest workspace
(`vitest.workspace.ts`) splits them into two projects:

- **unit** — `packages/*/src/**/*.test.ts(x)`, excluding `*.e2e.test.ts`
- **e2e** — `packages/*/src/**/*.e2e.test.ts` only (gated behind `WORKFLOW_E2E=1`)

Add a test next to the code it covers. Reach for the shared, **deterministic** test helpers in
**`@workflow/test-support`** (private, never published) instead of hand-rolling fixtures:

- **Reusable fakes** (re-exported through this one import path): `createScriptedRunner()` /
  `createMockRunner()` (`@workflow/core`) for a deterministic `AgentRunner`, and
  `createFakeProcessRunner()` (`@workflow/adapters`) for adapter tests — don't spawn real CLIs in
  unit tests.
- **Leaf data factories**: `event(type, overrides)` (a type-safe per-variant `WorkflowEvent`
  builder), `agentResult()`, `usage()`, `agentRequest()`, `runCtx()`, `workflowSource()`. Each is
  `fixed defaults + a shallow Partial override` — spell out only the fields a test asserts on.
- **CLI-specific fakes** stay in `packages/cli/src/test-support.ts`: `fakeDeps(overrides)` builds a
  capability-grouped `AppDeps` (`clock`/`env`/`io`/`adapters`/`ui`/`consent`/`proc` — override a
  group shallowly, e.g. `fakeDeps({ ui: { start } })`), `memFs()`, and `runMeta()`.

**Determinism is the rule, not a style choice.** Factories never randomize — defaults are fixed
constants (`at: 0`, `outputTokens: 0`) and there is no shared mutable counter (it would leak state
across tests and break replay). **Do not add `faker.js`** or any random-data lib; for generative
coverage use **`fast-check`** (already a devDep — seeded and shrinking, so failures reproduce).

Because `@workflow/test-support` depends on `@workflow/core`/`@workflow/adapters` yet their own
tests consume it, pnpm reports a **cyclic workspace dependency** warning on install — it is harmless
(a dev-only cycle; build/typecheck/test all pass).

## TypeScript conventions

`tsconfig.base.json` is **strict** and then some — code must satisfy:
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and
`verbatimModuleSyntax` (so use `import type { … }` for type-only imports). Module resolution is
`Bundler`; everything is ESM.

**Errors are values, not exceptions.** The codebase uses **neverthrow** `Result<T, E>` throughout.
`@workflow/core` defines a `WorkflowError` tagged union (`AdapterSpawn`, `SchemaValidation`,
`SandboxViolation`, `JournalCorrupt`, `BudgetExhausted`, `AgentCapExceeded`, `HarnessNotDeclared`);
`AgentRunner.run()` and the schema/adapter helpers all return `Result`. Inside a workflow body the
runtime bridges a failed `Result` into a thrown `WorkflowThrow` so author code can use normal
`try/catch`/`await`. Match the surrounding `Result` style — don't introduce raw `throw`/`try` in
library code that already threads `Result`.

Schemas are **zod**; `@workflow/schema` is the only place that touches `z.toJSONSchema()` / `safeParse`.

## Architecture

Dependency direction: `schema` → `core` → `adapters` → `cli`, with `ui`, `examples`, `workflow`, and
the test-only `test-support` at the edges.
Packages are wired by **dependency injection** — `createRuntime()`, the CLI commands (`AppDeps`), and
the adapters all take their collaborators as arguments, which is what makes them testable with the
fakes above. `AppDeps` is **capability-grouped**: services stay top-level (`registry`, `config`) and
host capabilities are nested roles (`clock`, `env`, `io`, `adapters`, `ui`, `consent`, `proc`), so
each command declares only the slice it needs via `Pick<AppDeps, …>` and tsc catches accidental new
dependencies.

### `packages/core` — the execution engine

`createRuntime(deps)` returns the `Runtime` exposed to workflow scripts:
`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()`, `askUserQuestion()`, and
`budget`. Each `agent()`
call walks a fixed sequence: increment seq → emit `agent-queued` → check abort → **journal lookup by
seq** (return cached result on hit — this is how resume works) → budget gate → agent-cap gate →
acquire **semaphore** slot → convert zod schema to JSON Schema → invoke `runner.run()` → validate
output → record to journal → emit events → release slot.

`askUserQuestion(opts)` is deterministic human-in-the-loop: it **shares the agent seq counter** and
walks a subset of that sequence — emit `question-asked` → abort check → **journal lookup by seq**
(cached answer short-circuits, so resume never re-asks) → skip the budget/cap gates (a question costs
no tokens, isn't an agent) → acquire a dedicated **question lock** (only one prompt owns the keyboard;
in-flight agents keep running, concurrent questions queue) → resolve via the injected `deps.askUser`
handler → record the answer to the journal (`outputTokens: 0`) → emit `question-answered`. The answer
enters through the event/handler boundary, so replay is byte-identical. In the CLI, foreground runs
resolve it via the Ink `QuestionPrompt` (a `{type:'answer'}` UI action); headless runs resolve from the
`--answers` map, then the question's `default`, else fail fast with a `WorkflowError`.

Key invariants when editing the runtime:

- **Determinism / sandbox** (`sandbox.ts`): scripts run in a Node `vm` context. `transformScript()`
  rewrites `export default defineWorkflow(...)` (so `run()` is invoked with the live runtime) and the
  legacy `export const meta = …` form, strips `import ... from "workflow"` lines, and wraps the body in
  an async IIFE; `extractMeta()` runs the script with sentinel-throwing stubs to read the metadata
  cheaply (used for the consent gate before a real run — for a `defineWorkflow` file it reads the
  metadata object passed in). `Date.now()`, `Math.random()`, and argless `new Date()` are **forbidden**
  inside the sandbox — they would break journal replay. Don't add nondeterministic globals.
- **Budget** is a *soft* gate, not a reservation — under concurrency a run can overshoot because
  several agents read `remaining()` before any records. `remaining()` is `Infinity` when no cap is set.
- **Nested workflows** are one level deep only: `workflow()` creates a child runtime that **shares the
  parent's budget** but whose own `workflow()` throws.
- **Events are the observable** (`events.ts`): the runtime emits a typed `WorkflowEvent` stream;
  `reduce(state, event)` rebuilds `RunState`, which is what the UI and registry consume. New runtime
  behavior should surface through events, not side channels.

`HarnessId` = `"claude" | "codex" | "copilot" | "raw-api"`.

### `packages/adapters` — harness backends

Each adapter implements `AgentRunner { id, capabilities, run(req, ctx) }` and maps the uniform
`AgentRequest` → a specific backend: `claude.ts` (CLI `--json-schema`), `codex.ts` (schema via temp
file, output read back from a file), `copilot.ts` (prompt + validation/retry loop), `raw-api.ts`
(Anthropic SDK directly — needs `ANTHROPIC_API_KEY`). `generic.ts` builds a config-driven adapter for
any CLI. Process spawning goes through the `ProcessRunner` abstraction (real or fake). Schema handling
differs per backend, so `coercion.ts` (`runWithSchemaRetry`) + `json.ts` (`extractJson`, AJV
validator) normalize/repair model output with retries. `detect.ts` probes `PATH` for available CLIs
and declares each adapter's `capabilities` (native schema, token reporting, tool events).

### `packages/cli` — `workflow` binary

Bin entry `workflow` → `dist/cli.js`. `dispatch(argv, deps)` is a pure router over `AppDeps`:

```
workflow run <script> [--args '{...}'] [--detach] [--yes] [--mock] [--answers '{...}']
workflow watch <id> | list | resume <id> | stop <id> | save <id> | adapters
workflow <name> [--args ...]      # run a saved workflow by name
```

`--mock` runs the whole workflow against a fabricating runner (`createMockRunner` in core) instead
of a real harness: every `agent()` returns schema-valid dummy data, so authors can iterate on control
flow, phases, and the UI with **no agents spawned and no tokens spent**. It always runs foreground,
skips the consent gate, and the declared harness need not be installed (still validated for typos).

`--answers '{"<key>":"<value>"}'` pre-supplies answers for `askUserQuestion()` calls, keyed by each
question's `key`. It's the headless story: a non-TTY/`--detach`/CI run resolves each question from this
map, then the question's `default`, else fails fast (`WorkflowError`) rather than hanging on input. The
map is threaded onto the run meta so a detached child reads it back; `watch` shows questions read-only.

A workflow's harness is **declared in `meta.harness`** and is the single source of truth — there is no
auto-detect and no CLI/config override of it. `adapter-select.ts` resolves that to an adapter
instance. Runs are persisted by `registry.ts` under `~/.workflow/runs/{runId}/` (events + journal as
JSONL) which is what powers `watch`, `resume`, and `save`. `consent.ts` gates execution: non-TTY/CI,
`--yes`, or a saved consent auto-allows; an interactive TTY prompts. Foreground runs render the Ink UI
with pause/stop/save controls; `--detach` spawns a headless child you tail via `watch`. Config is
layered from `~/.workflow/config.json` then `./.workflow/config.json` (`config.ts`).

### `packages/ui` — Ink TUI

React + **Ink** terminal dashboard. `startUi({ subscribe, … })` subscribes to the event stream; on a
TTY it renders a throttled (100ms) three-pane layout (phases / agents / detail) driven by `RunState`
+ pure `selectors.ts`, with `navReducer` handling arrow/vim navigation. Non-TTY falls back to
plain-text log lines (`line-log.ts`). UI interactions are emitted back through an `onAction` callback.
When `RunState.pendingQuestion` is set (an `askUserQuestion()` is waiting), `App.tsx` swaps to
`QuestionPrompt.tsx` — markdown question + arrow-selectable choices + an optional "Other" free-text
input — and routes keypresses there; submitting dispatches a `{type:'answer'}` action. The non-TTY
log renders questions as `?`/`↳` lines.

### `packages/workflow` — the authoring entrypoint

The public package (npm name `defineworkflow`) that workflow files import from. It exports `defineWorkflow`,
the runtime primitive stubs (`agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow`/`askUserQuestion`),
`z` (the engine's zod instance), `args`, `budget`, and types (`AgentOptions`, `AskUserQuestionOptions`,
`HarnessId`, `WorkflowMeta`, …).
These imports exist purely for TypeScript/editor support — autocomplete and compile-time checks; the
runner strips them and injects the live runtime values into the sandbox at execution time (see
`transformScript()` above). It replaces the old ambient `workflow-globals.d.ts` as the source of editor
types, and also provides the `defineworkflow` CLI bin. `agent({ schema })` accepts either a plain JSON
Schema object or a **zod schema** (`z.object({ … })`): a zod schema makes `agent()` return the schema's
inferred output type (e.g. `await agent(p, { schema: z.object({ n: z.number() }) })` resolves to
`{ n: number }`), while a plain JSON Schema resolves to `unknown`. The runtime normalizes zod →
JSON Schema via `@workflow/schema`'s `toJsonSchema` before validating (`isZodSchema` duck-types it).
`defineWorkflow` makes the metadata type-safe: e.g.
`harness` only accepts `"claude" | "codex" | "copilot" | "raw-api"`, so tsc rejects typos. The
metadata fields are `name`, `description`, `harness`, `phases`, the optional `whenToUse?: string`
(a hint shown in the saved/bundled workflow list), and the optional `output?: string`. When `output`
is set, a finished run's return value is persisted there — `result.json` holds the value verbatim and
each top-level string field is also extracted to its own file (`<key>.<ext>`, extension sniffed from
content); when omitted, the return value is only printed to the terminal. Either way the CLI always
prints the returned object on completion (`artifacts.ts` + `emitArtifacts` in `execute.ts`).

### `packages/examples`

Runnable example workflows (private). `src/haiku.workflow.ts` is the minimal single-`agent()` example
(a `defineWorkflow` default export); run via `pnpm example` or
`workflow run packages/examples/src/haiku.workflow.ts --yes`.

### `packages/test-support`

Private, test-only package — the shared home for deterministic test helpers (see *Test layout &
conventions* above). `src/factories.ts` holds the leaf data factories (`event`, `agentResult`,
`usage`, `agentRequest`, `runCtx`, `workflowSource`); `src/index.ts` also re-exports the engine's
reusable fakes so tests have one import path. Never imported by production code.

## Reference

- `docs/solutions/` — searchable knowledge store of past problems and learnings, one file per
  problem with YAML frontmatter (category/tags/problem_type). Read the relevant file **before**
  implementing or debugging in a documented area; add entries with the `compound` skill after solving
  something. `index.md` is auto-maintained — don't edit it by hand.
- `docs/superpowers/specs/` and `docs/superpowers/plans/` — design specs and implementation plans
  (orchestrator design, per-package plans, the VitePress docs-site design).

## Reference repositories

Source-of-truth code for libraries we depend on. Treat as **read-only reference material** — do not edit files under `repos/`. When asked about a library listed below, explore its source here first instead of guessing or relying on training data.

- `repos/ink/` — https://github.com/vadimdemedes/ink.git @ master (squashed)
