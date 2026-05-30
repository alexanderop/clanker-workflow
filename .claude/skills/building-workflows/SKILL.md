---
name: building-workflows
description: Use when authoring, writing, editing, or debugging a defineWorkflow workflow file (*.workflow.ts) with the `defineworkflow` package — orchestrating coding agents via agent()/parallel()/pipeline(), declaring meta.harness, returning structured output with zod schemas, reading args, asking the human a question, or when a run fails with errors about Date.now/Math.random being forbidden or "defineWorkflow must be the first runtime statement".
---

# Building Workflows

## Overview

A **workflow** is a single TypeScript file that orchestrates coding-agent calls. You write the
control flow; agents do the work. Execution is **deterministic and journaled**: every `agent()`
result is recorded by sequence number, so a crashed or paused run replays from a checkpoint without
re-invoking the model. That durability is *why* the rules below exist — anything nondeterministic
would break replay.

You author against the `defineworkflow` package. The imports are type-only stubs for editor
autocomplete; at run time the CLI strips them and injects the live runtime into a VM sandbox.

```bash
npm install defineworkflow      # provides the `defineworkflow` CLI + authoring types
```

## The shape (copy this)

```ts
// tweet-contest.workflow.ts
import { agent, args, defineWorkflow, log, parallel, phase, z } from "defineworkflow";

export default defineWorkflow({
  name: "tweet-contest",
  description: "Draft 3 tweets in parallel, then judge the best",
  harness: "claude",                                   // required — see harness table
  phases: [{ title: "Draft" }, { title: "Judge" }],    // optional, drives the progress UI
  async run() {
    // Schemas + profiles MUST be declared INSIDE run() (see Rule 1).
    const Draft = z.object({ tweet: z.string(), hook: z.string() });

    // `args` is `unknown` — cast it once (see Rule 3).
    const { topic } = (args ?? {}) as { topic?: string };
    const subject = topic ?? "durable workflows";

    phase("Draft");
    log(`drafting tweets about: ${subject}`);
    const angles = ["witty", "contrarian", "heartfelt"];
    const drafts = await parallel(
      angles.map((angle) => () =>
        agent(`Write a ${angle} tweet (<280 chars) about "${subject}". Return the tweet and its hook.`,
          { label: `draft:${angle}`, phase: "Draft", schema: Draft }),
      ),
    );

    phase("Judge");
    const candidates = drafts.map((d, i) => `#${i} (${d.hook}): ${d.tweet}`).join("\n");
    const verdict = await agent(
      `Pick the best tweet about "${subject}".\n${candidates}\nReturn the 0-based winnerIndex and a reason.`,
      { label: "judge", phase: "Judge", schema: z.object({ winnerIndex: z.number().int(), reason: z.string() }) },
    );

    const winner = drafts[verdict.winnerIndex] ?? drafts[0]; // index access is `T | undefined` — guard it
    return { topic: subject, reason: verdict.reason, tweet: winner?.tweet };
  },
});
```

## Non-negotiable rules

These are the things that silently break a run or fail to type-check. Get them right first.

1. **`defineWorkflow(...)` must be the FIRST runtime statement in the file.** Only `import`s and
   *type-only* declarations (`interface`, `type`) may precede it. So declare your **zod schemas and
   `profile()` calls INSIDE `run()`**, not at module scope. A `const Schema = z.object(...)` at the
   top of the file is the most common cause of a workflow that won't start.
2. **No nondeterministic globals.** `Date.now()`, `Math.random()`, and argless `new Date()` are
   forbidden inside the sandbox — they break journal replay. Need a unique path or seed? Pass it via
   `args`. `Array.map/filter/forEach`, `JSON`, `Math.*` (except random) are fine.
3. **`args` is `unknown`.** Cast it: `const { topic } = (args ?? {}) as { topic?: string }`. Reading
   `args.topic` directly does not type-check.
4. **`harness` is required and is the single source of truth.** No auto-detect, no CLI override. The
   declared CLI must be installed to run for real (`--mock` skips that).
5. **Index access is `T | undefined`** (`noUncheckedIndexedAccess`). `parallel`/`pipeline` return
   arrays — guard `arr[i]` with `?.` or `?? fallback`.

## Primitives

| Primitive | Signature | Use |
|---|---|---|
| `agent(prompt, opts?)` | `(string, { label?, phase?, model?, schema? }) => Promise<T \| unknown>` | Invoke one coding agent. With a zod `schema`, resolves to the inferred type; without, resolves to the raw text as `unknown`. |
| `agent(profile, prompt, opts?)` | adds a leading `Profile` | Apply reusable defaults (see `profile()`). |
| `parallel(thunks)` | `Array<() => Promise<T>> => Promise<T[]>` | **Barrier.** Pass *thunks* (`() => agent(...)`), not promises. Awaits all; a thrown thunk becomes `null` in the array — `.filter(Boolean)`. |
| `pipeline(items, ...stages)` | each stage `(prev, item, i) => Promise<R>` | **No barrier.** Each item flows through all stages independently; item B can be in stage 1 while A is in stage 3. A throwing stage drops that item to `null`. Default for multi-stage work. |
| `phase(title)` | `(string) => void` | Switch the active progress group; match a `meta.phases[].title`. |
| `log(msg)` | `(string) => void` | Emit a progress line. |
| `askUserQuestion(opts)` | `({ key, question, choices?, allowOther?, default }) => Promise<string>` | Pause and ask the human; `question` is markdown. Answer is journaled (resume never re-asks). Headless falls back to `--answers` then `default`. |
| `workflow(ref, args?)` | runs another workflow inline | Nested one level deep only; shares the parent budget. |
| `profile(config)` | `({ instructions?, model?, ... }) => Profile` | Bundle reusable agent defaults; declare inside `run()`. |
| `budget` | `{ total, spent(), remaining(), record() }` | Token budget; `remaining()` is `Infinity` when uncapped. |

## Structured output with zod

Use the **re-exported `z`** (`import { z } from "defineworkflow"`) — not a separate `zod` install.
A zod `schema` makes `agent()` return the inferred type and validates output at run time:

```ts
const out = await agent("Invent a headline.", {
  schema: z.object({ title: z.string(), impact: z.enum(["high", "medium", "low"]) }),
});
// out: { title: string; impact: "high" | "medium" | "low" }
```

`.describe(...)` on fields steers the model. Without a schema, the result is the agent's text typed
as `unknown` — cast it (`(await agent(p)) as string`).

## parallel vs pipeline

- **`parallel`** when you need *all* results together at one point (fan-out then combine). It is a
  barrier: the slowest thunk gates the rest.
- **`pipeline`** when each item runs a *multi-stage chain* and stages don't need cross-item context.
  No barrier — wall-clock ≈ the slowest single chain, not sum-of-slowest-per-stage. Stage callbacks
  receive `(prevResult, originalItem, index)`.

Don't reach for a barrier just to `map`/`filter` between stages — do that inside a pipeline stage.

## meta fields

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Identifier; used by `save` / run-by-name. |
| `description` | yes | One line shown in lists and the consent gate. |
| `harness` | yes | `"claude" \| "codex" \| "copilot" \| "raw-api"`. `raw-api` needs `ANTHROPIC_API_KEY`. |
| `phases` | no | `Array<{ title, detail? }>` — labels the progress UI; pair with `phase()`. |
| `whenToUse` | no | Hint shown in the saved/bundled workflow list. |
| `output` | no | A directory path. When set, the return value is persisted (`result.json` + each top-level string field to its own file). Omitted → return value only printed. |

## Running & iterating

```bash
defineworkflow run tweet-contest.workflow.ts --args '{"topic":"rust"}'   # real agents, uses tokens
defineworkflow run tweet-contest.workflow.ts --mock                       # fabricates schema-valid data — NO agents, NO tokens
defineworkflow run <file> --detach        # headless; tail with `watch`
defineworkflow run <file> --yes           # skip the interactive consent gate (also auto-skipped in CI/non-TTY)
defineworkflow list | watch <id> | resume <id> | stop <id> | save <id>
defineworkflow adapters                    # show which harness CLIs are installed
```

**Iterate on control flow with `--mock` first** — every `agent()` returns dummy data matching its
schema, so you can debug phases, fan-out, and the return shape with no agents spawned and no tokens
spent. The declared harness need not be installed under `--mock`.

## Common mistakes

| Symptom | Cause | Fix |
|---|---|---|
| "defineWorkflow must be the first runtime statement" / run won't start | `const X = z.object(...)` or `profile()` at module scope | Move schemas/profiles **inside `run()`**. |
| `args.topic` type error | `args` is `unknown` | Cast once: `const { topic } = (args ?? {}) as { topic?: string }`. |
| "Date.now is not defined" / sandbox violation | nondeterministic global | Remove it; pass values via `args`. |
| `parallel` runs only the first / odd results | passed promises, not thunks | Wrap each: `parallel(items.map(x => () => agent(...)))`. |
| `arr[i]` is possibly undefined | `noUncheckedIndexedAccess` | Guard with `?.` / `?? fallback`. |
| Result typed `unknown`, can't read fields | no `schema` on `agent()` | Add a zod `schema`, or cast the text. |
| `tsc` rejects the harness string | typo | Use exactly one of `claude` / `codex` / `copilot` / `raw-api`. |
| Workflow ran but produced no files | no `meta.output` | Set `output: "<dir>"` to persist the return value. |
| Burned tokens debugging control flow | ran for real | Use `--mock` until the shape is right. |
```

