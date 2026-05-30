---
title: "Harness-neutral live agent progress: normalize at the adapter via StreamTranslator → onProgress"
date: 2026-05-30
track: knowledge
category: architecture-patterns
problem_type: "workflow_pattern"
module: "adapters"
component: "stream-translators"
tags: ["streaming", "adapters", "progress", "onprogress", "stream-translator", "ui", "liveness", "tokens", "tool-events", "coalescing"]
applies_when: "adding live progress (tokens/tools/model/elapsed) for a coding-agent harness, or touching the agent-progress/agent-tool event path"
related:
  - "architecture-patterns/workflow-sandbox-script-constraints.md"
---

# Harness-neutral live agent progress: normalize at the adapter via StreamTranslator → onProgress

## Context

The TUI used to show every agent stuck on `running · 0 tok · 0s` for a whole run: the claude
adapter used non-streaming `--output-format json` (nothing emitted until the process exits) and
the header's elapsed was derived from the *last event's* timestamp, so with no mid-run events the
clock visibly froze. The three installed CLIs (claude/codex/copilot) all emit newline-delimited
JSON event streams, but with **different taxonomies**. We needed one live progress story that the
reducer/selectors/UI never have to special-case per harness.

## Guidance

**Put the normalization boundary at the adapter.** Each adapter owns a pure `StreamTranslator`
that maps its native NDJSON events into one shared contract; everything above the adapter is
harness-agnostic.

```
claude  stream-json --verbose ─┐
codex   exec --json            ┼─► StreamTranslator ─► ctx.onProgress({tool?, tokens?, model?})
copilot --output-format json  ─┘            │
                                            ▼  runtime emits agent-tool / agent-progress (keyed)
                                   reduce → RunState → pure selectors → Ink panes
```

Concrete pieces (all wired by dependency injection, testable with the in-memory fakes):

- **Contract** (`@workflow/core`): `AgentProgress { tool?, tokens?, model? }` plus
  `RunCtx.onProgress?`. Adapters that can't stream simply never call it — everything still works,
  just without live updates.
- **ProcessRunner** gained an optional `onLine?(line)` — a rolling buffer splits stdout on `\n`
  and invokes it per complete line while still accumulating the full `stdout` for back-compat.
  Each adapter spawns with its streaming flag, passes `onLine`, runs `translator.push(line)` →
  `ctx.onProgress(p)` per progress, and reads final text/data/usage from `translator.result()`.
- **Translators are pure** `{ push(line): AgentProgress[]; result(): {text,data?,usage,isError?} }`
  factories, unit-tested against captured `*.ndjson` fixtures (`packages/adapters/fixtures/`).
  `push` returns an **array** so one assistant message can yield several tool events + a token
  update.
- **Events** (`core/events.ts`): `agent-tool` (one per tool), new `agent-progress`
  (`{key, tokens?, model?, at}`, coalesced ≤1/sec in the runtime), and `agent-finished` carries
  `model`. `AgentState` gains `startedAt/endedAt/model/liveTokens`; `RunState` gains
  `startedAt/endedAt`. The reducer keeps `liveTokens` **monotonic** (`Math.max`).
- **UI selectors are pure with `now` injected** (`formatDuration/formatModel/humanizeTool/
  activityDigest/promptPreview/agentRow/detailSections`). `App` runs a single ~250ms ticker that
  bumps the spinner frame + `now` **only while `RunState.status === "running"`**.

### Non-obvious rules that bite

1. **Coalescing must seed `lastProgressAt = -Infinity`** so the *first* update always emits;
   otherwise with a fixed clock (`now() === 0` in tests) every progress is dropped. And emit the
   **best-known** `maxTokens` on every coalesced flush (not just when *this* update carried
   tokens), so a model-only update still flushes tokens seen since the last emit.
2. **Per-harness token semantics differ — accumulate, don't overwrite.** codex emits one
   `turn.completed` *per turn*; sum their usage or a multi-turn run undercounts (and the budget
   gate reads that). claude reports `output_tokens` *per assistant message*; sum across messages
   for a cumulative live count. The authoritative final usage still comes from each harness's
   terminal (`result`/`turn.completed`) event.
3. **Freeze elapsed at `run-finished`** (`RunState.endedAt`), not live `now`. Otherwise *watching*
   a finished run shows wall-clock-since-finish instead of the true duration.
4. **The UI may call `Date.now()`; the workflow sandbox may not.** The ticker is a normal process;
   the `Date.now()`/`Math.random()` ban only applies inside the VM sandbox (see related doc).
5. **`agent-progress` is persisted to `events.jsonl` but never journaled** — progress does not
   influence replay/determinism. Corollary: `agent-finished.model` is blank on journal replay
   (cached) and for non-streaming adapters (raw-api), since model isn't persisted. Journaling the
   model would be the fix if attribution-on-resume is needed.
6. **`exactOptionalPropertyTypes` is on** — never spread `{ errorMessage }` when it may be
   `undefined`; gate each optional field with `...(x !== undefined ? { x } : {})`.

## Why This Matters

Isolating each CLI's quirks in a small, fixture-tested translator contains the blast radius when a
CLI's event taxonomy drifts across versions, and keeps the reducer/selectors/components 100%
harness-agnostic — a new harness is one translator + one fixture, no UI changes. Getting the
coalescing seed, token accumulation, and elapsed-freeze rules wrong produces *plausible-looking*
but wrong numbers (frozen clocks, undercounted budgets, giant elapsed on watched runs) that unit
tests with a fixed clock won't surface unless you test those exact edges.

## When to Apply

- Adding a new harness adapter, or changing how an existing one reports tokens/tools/model.
- Touching `agent-progress`/`agent-tool` emission, the coalescing window, or `reduce`'s
  live-token/timestamp handling.
- Building any UI element that shows live per-agent metrics.

## Examples

Drive the built engine with a runner that calls `onProgress` to verify the whole path without a
real agent (no tokens, no network):

```js
const runner = {
  id: "fake-stream",
  capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: true },
  async run(req, ctx) {
    ctx.onProgress?.({ model: "claude-opus-4-8[1m]" });
    ctx.onProgress?.({ tool: { name: "WebFetch", input: { url: "https://alexop.dev" } } });
    ctx.onProgress?.({ tokens: 120, model: "claude-opus-4-8[1m]" });
    ctx.onProgress?.({ tokens: 340 });
    return ok({ text: "found 2 posts", usage: { inputTokens: 10, outputTokens: 106 }, toolCalls: [] });
  },
};
// Use a monotonically increasing now() (e.g. +1500/call) so coalescing (≥1s) lets progress through.
// Expect: agent-started → agent-progress(model) → agent-tool → agent-progress(120,model)
//         → agent-tool → agent-progress(340,model) → agent-finished(model, usage).
```

Per-harness translator + fixture pairs live in `packages/adapters/src/{claude,codex,copilot}-stream.ts`
and `packages/adapters/fixtures/*.ndjson`. See also
[[workflow-sandbox-script-constraints]] for the determinism boundary the ticker sits outside of.
