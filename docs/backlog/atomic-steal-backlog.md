# Backlog — ideas stolen from `atomic`

Source: [github.com/flora131/atomic](https://github.com/flora131/atomic) (by the Lavaee brothers,
internal package scope `@bastani/*`). It's a direct cousin of this repo — a multi-harness
coding-agent TUI plus a `defineWorkflow` orchestration SDK with journaling/resume, git-worktree
isolation, and an OpenTUI dashboard. Surveyed 2026-05-30 from a shallow clone (`/tmp/atomic-inspect`,
ephemeral).

These are candidate features for **our** engine (`packages/core` runtime, `packages/adapters`,
`packages/ui`, `packages/workflow` authoring API). Each ticket says what atomic does, where it lives
in their tree, and what we'd build here. Ranked by leverage.

How to read priority: **P1** = biggest capability gap or highest leverage, **P2** = nice addition,
**P3** = optional / situational.

---

## ATOM-1 — Automatic DAG inference from execution order  ·  P1 · effort: S

**Idea.** Infer a real dependency graph from *when* stages spawn vs. settle — no author-declared
edges. Maintain a `frontier` set; on stage spawn, snapshot the current frontier as that stage's
parents; on settle, remove its parents from the frontier and add itself. You get a visualizable DAG
for free.

**In atomic.** `packages/workflows/src/runs/shared/graph-inference.ts` — `GraphFrontierTracker`
(`onSpawn` / `onSettle` / `getParents`, plus `replaceParents` for replay topology). ~80 lines,
self-contained.

**For us.** Today our structure is imperative (`parallel()` / `pipeline()`) and the UI shows flat
phase groups. Layer a frontier tracker over `agent()`/`parallel()`/`pipeline()` in `packages/core`,
emit parent edges on the existing `WorkflowEvent` stream, and render a real graph view in the Ink UI
(`packages/ui`) instead of (or alongside) phase groups.

**Why first.** Lowest risk, highest visible payoff, fully portable, no new external dependency. Slots
into our event-as-observable model (`events.ts` → `reduce` → `RunState`).

**Acceptance sketch.** A workflow using `parallel()` then a dependent `agent()` produces edges
parent→child in `RunState`; UI shows the branch/merge.

---

## ATOM-2 — Intercom: agent ↔ orchestrator back-channel  ·  P1 · effort: L

**Idea.** A separate **broker process** over a socket lets sub-agents message their supervisor
mid-run via a `contact_supervisor` tool with three modes:
- `progress_update` — fire-and-forget status,
- `need_decision` — blocks the agent until the orchestrator replies,
- `interview_request` — a structured multi-question form (typed options), answers parsed back as JSON.

Also does session presence/status (idle / thinking / `tool:<name>`) and idle-batched delivery
(queue while busy, flush ~200ms after going idle).

**In atomic.** `packages/intercom/` (broker, client, reply-tracker, types) and
`packages/workflows/src/intercom/` (bridge/routing). `contact_supervisor` tool ≈ `index.ts:1033–1305`.

**For us.** Biggest genuine *capability* gap — our dispatch is strictly one-shot; a running agent
can't ask the orchestrator anything. Would need: a back-channel transport, a journaled
request/response so it survives replay, and adapter wiring to expose the tool. Pairs with ATOM-3/4.

**Risk / open questions.** Determinism — a blocking `need_decision` must be journaled like an agent
result so resume doesn't re-prompt. Decide broker-process vs. in-proc channel given our VM sandbox.

---

## ATOM-3 — HIL detection → unified `awaiting_input` status  ·  P1 · effort: M

**Idea.** Detect *that an agent is blocked waiting on the human* and surface it distinctly. Per
harness: Claude via `fs.watch()` on the JSONL transcript scanning for unresolved `AskUserQuestion`
tool calls; Copilot via native `user_input.requested` events; OpenCode via SSE. All funnel into one
`onHIL(waiting: boolean)` callback → session flips to `awaiting_input` (blue pulsing border vs.
yellow "running").

**In atomic.** spec `specs/2026-04-14-hil-detection-ui-surfacing.md`.

**For us.** Maps cleanly onto our `StreamTranslator → onProgress` normalization boundary
(see `docs/solutions/architecture-patterns/streaming-agent-progress-normalization-boundary.md`).
Add an `awaiting_input` run/agent state to the event union and a distinct Ink rendering. We already
normalize progress; this normalizes *blocked-on-human*.

---

## ATOM-4 — Model fallback with a retryable-error classifier  ·  P1 · effort: M

**Idea.** Per-stage `fallbackModels: [...]`. Build a candidate list deduped against the primary; a
classifier retries only on rate-limit / quota / auth / 5xx / overload (never tool / validation / user
errors); **preflight** model resolution so a typo fails fast instead of mid-run; record per-attempt
metadata in the result (`attemptedModels`, `modelAttempts`).

**In atomic.** spec `specs/2026-05-14-workflow-sdk-fallback-models.md`; helper pattern
`packages/workflows/src/runs/shared/model-fallback.ts`.

**For us.** Fits our `Result`/`WorkflowError` style — add a `Retryable` classification and a fallback
loop in `AgentRunner.run()` (`packages/adapters` + `packages/core`). Surface attempts through events
for observability. We have `budget`; this adds resilience.

---

## ATOM-5 — `ask-user-question` as a first-class DSL node  ·  P2 · effort: M

**Idea.** Deterministic human-in-the-loop *inside* the workflow body. `question` can be a function of
current state; `onAnswer` maps the reply into state. Reuses the HIL UI; renders question text as
markdown; dynamic, contextual prompts.

**In atomic.** spec `specs/2026-03-23-ask-user-question-dsl-node-type.md`.

**For us.** New runtime primitive in `packages/core` + stub in `packages/workflow`. The answer must be
**journaled** (like an agent result) so replay doesn't re-ask. Pairs with ATOM-3. Mind our sandbox
constraints (no `Date.now`/`Math.random`).

---

## ATOM-6 — Ralph: ready-set DAG scheduler + eager dispatch  ·  P2 · effort: L

**Idea.** A centralized coordinator that's the *sole writer* of a `tasks.json`, computes the ready set
(`pending` + all `blockedBy` complete), dispatches workers in parallel, and **re-evaluates on each
`onAgentComplete`** — so a freshly-unblocked task dispatches immediately instead of waiting for the
slowest task in its wave (eager dispatch). Handles deadlock detection and bounded retries.

**In atomic.** specs `specs/2026-02-16-ralph-dag-orchestration.md`,
`specs/2026-03-18-ralph-eager-dispatch.md`, `specs/2026-03-23-ralph-review-debug-loop-termination.md`.

**For us.** This is the *dynamic, agent-generated task list* version (vs. our statically-authored
`pipeline()`). Could ship as a higher-level helper built on our primitives. Lower priority unless we
want agent-authored DAGs.

---

## ATOM-7 — Ancestor-agent retry on schema-validation failure  ·  P2 · effort: M

**Idea.** When a downstream tool/node fails input (Zod) validation, walk *backward to the nearest
ancestor agent* and re-run it with the error injected, so the LLM regenerates conforming output —
rather than retrying the failing tool.

**In atomic.** spec `specs/2026-02-11-workflow-sdk-implementation.md` §5.3.

**For us.** Smarter than our current flat schema-retry — relevant to `coercion.ts` /
`runWithSchemaRetry` and `json.ts` in `packages/adapters`. Needs the DAG/ancestry from ATOM-1 to know
who the "nearest ancestor agent" is.

---

## ATOM-8 — A `PRODUCT.md` / design-principles doc for the TUI  ·  P3 · effort: S

**Idea.** A tight brand + design-principles doc that doubles as a UI spec: canonical palette
(Catppuccin Mocha), layout constants (24-char sidebar, collapse < 80 cols, rounded borders,
sticky-bottom scroll), a fixed Unicode icon set (no emoji), `NO_COLOR` respect, braille spinner at
80ms, and principles like "earn every element" / "trust through transparency".

**In atomic.** `/tmp/atomic-inspect/PRODUCT.md` (copy is in this survey if the clone is gone).

**For us.** Write an equivalent for `packages/ui` so the Ink TUI has a single source of design truth.

---

## ATOM-9 — Ship a library of ready-to-use built-in workflows  ·  P1 · effort: M (per workflow)

**Idea.** Like atomic's named built-ins (ralph / deep-research / goal), ship our own curated,
supported, tested workflows that users run by name: `workflow deep-research --args '{...}'`.

**In atomic.** spec `specs/2026-02-02-atomic-builtin-workflows-commands.md`; definitions authored with
their `defineWorkflow(...).run().compile()` builder and exposed as named commands.

**For us — plumbing already exists.** `packages/cli/src/resolve.ts` resolves a name through
project → personal → **bundled** tiers; `bundledDir` is wired to `packages/examples`
(`packages/cli/src/node-deps.ts:104`). A `<name>.workflow.ts` in the bundled dir is runnable as
`workflow <name>` today. `WorkflowMeta.whenToUse` is the list-hint for these. No new resolver work
needed — this ticket is **authoring + packaging**, not engine plumbing.

**Shippability of the three atomic ships:**
- **deep-research** — ✅ buildable now on existing primitives (`parallel()` fan-out → `pipeline()`
  verify → aggregator `agent()`). Mine our existing `deep-research` *skill* for prompt structure.
  Recommended **first** built-in.
- **goal** (loop-until-done) — ✅ mostly now: `while` loop gated on `budget.remaining()` + a
  "done?" check agent. It's a pattern more than new engine work.
- **ralph** (autonomous, agent-generated DAG) — ⚠️ depends on **ATOM-1** (DAG inference) and
  **ATOM-6** (ready-set / eager-dispatch scheduler). Ship a fixed-pipeline "ralph-lite" now; real
  version waits on those.

**Open decision.** Keep built-ins in `packages/examples` (current `bundledDir`) vs. split a dedicated
`packages/workflows-builtin` so examples stay disposable and built-ins are a tested, supported
surface. Lean toward the split once there are >2.

**Suggested order:** deep-research → goal → ralph-lite → real ralph (after ATOM-1/6).

---

## Already covered (no ticket)

- **Resume** — they checkpoint per node; our journal-by-seq replay is equivalent / cleaner.
- **Multi-harness adapters, `--mock` runner, `budget`, worktree isolation, `args`, output
  persistence** — present in both.
- **Authoring API** — atomic uses an immutable chained builder
  (`defineWorkflow(name).description().input().run().compile()`); ours is an object-literal `meta` +
  `run`. Don't switch — ours is terser with comparable typo-safety.

---

### Suggested order
ATOM-1 (quick win, unlocks ATOM-7) → ATOM-3 + ATOM-5 (HIL pair) → ATOM-4 (resilience) →
ATOM-2 (biggest, do once HIL plumbing exists) → ATOM-6 / ATOM-7 / ATOM-8 as capacity allows.
