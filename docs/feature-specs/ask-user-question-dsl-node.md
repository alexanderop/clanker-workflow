# Feature: `askUserQuestion()` — first-class human-in-the-loop DSL node

> Deterministic, journaled human-in-the-loop *inside* the workflow body — pause a run to
> ask the author a question, replay-safe so resume never re-asks.

## Overview

A new runtime primitive `askUserQuestion()` that a workflow body can `await` to ask the
human a contextual question mid-run and receive their answer. Because the question is a
normal call in `run()`, its text is naturally "a function of current state" — the author
already has all local state in scope. The answer is **journaled by sequence number** exactly
like an `agent()` result, so a replayed/resumed run returns the cached answer instead of
re-prompting. Foreground TTY runs render the question as markdown in an Ink prompt; headless
runs resolve answers from a pre-supplied map (or per-question default) and fail fast if an
answer is missing.

Tracks **ATOM-5** (P2, effort M). Pairs with ATOM-3. Atomic source spec:
`specs/2026-03-23-ask-user-question-dsl-node-type.md`.

## Goals

- Deterministic human-in-the-loop that survives crash/resume without re-asking.
- Reuse the existing seq/journal machinery — no new ordering domain.
- Reuse the existing Ink UI + event-stream + action-dispatch architecture.
- Keep CI/detached runs safe: questions never silently hang a headless run.
- Honor sandbox constraints — no `Date.now`/`Math.random`; answers come through events.

## API shape

One question per call (compose several with several awaited calls — each gets its own seq +
journal entry).

```ts
const ans = await askUserQuestion({
  key: 'deploy-target',          // stable string; used by --answers and journaling
  question: '## Where to deploy?\nPick the target environment.', // rendered as markdown
  choices: ['staging', 'production'],  // optional
  allowOther: true,              // adds an "Other → type your own" free-text path
  default: 'staging',            // used in non-interactive runs when no --answers entry
})
// ans: string
```

Decisions locked in brainstorming:

- **Answer model:** choices **plus** a free-text escape hatch (`allowOther`), mirroring
  Claude Code's own `AskUserQuestion`. Choices use arrow-key selection; "Other" reveals a
  text field. Returns a `string`.
- **One question per call** — simplest API, UI, and replay. Batching (1–4) is a future
  enhancement.
- **Explicit `key`, fallback to derived.** Author passes a stable `key`; `--answers` and the
  journal key on it. If omitted, derive `${seq}:${phase}:${label}` like `agent()` — fine for
  interactive use, but explicit keys are required-in-practice for the headless story.

## Implementation Details

### Core — `packages/core`

**Primitive (`runtime.ts`).** `askUserQuestion()` walks a *subset* of the `agent()` sequence:

1. `const mySeq = seq++` — **shares the agent seq counter** so global ordering stays
   consistent across `agent()` and questions.
2. Derive `key = opts.key ?? \`${mySeq}:${phase}:${label}\``.
3. Emit `question-asked` event.
4. Abort check (`deps.signal?.aborted`).
5. **Journal lookup by seq** — `deps.journal.lookup(mySeq)`; on hit, emit
   `question-answered` (cached) and return `cached.data`. This is what makes resume not
   re-ask.
6. **Skip budget gate and agent-cap gate** — a question costs no tokens and is not an agent.
7. Acquire the **question serialization lock** (new, exclusive) so only one prompt competes
   for the keyboard at a time; in-flight agents keep running. Questions raised concurrently
   inside `parallel()`/`pipeline()` branches queue behind it.
8. Resolve the answer via an injected `deps.askUser(request)` handler (returns a Promise<string>).
9. `deps.journal.record({ seq: mySeq, key, text: answer, data: answer, outputTokens: 0 })`.
10. Emit `question-answered`; release the lock; return `answer`.

The runtime gains a new injected dep, `askUser?: (req: QuestionRequest) => Promise<string>`,
analogous to `gate`/`control`. `createRuntime()` returns the new primitive alongside the
existing six.

**Events (`events.ts`).** Add to the `WorkflowEvent` union:

- `{ type: "question-asked"; key: string; question: string; choices?: readonly string[]; allowOther?: boolean; at: number }`
- `{ type: "question-answered"; key: string; answer: string; cached: boolean; at: number }`

Extend `reduce()` to track pending/answered questions in `RunState` (e.g. a
`pendingQuestion?: { key, question, choices, allowOther }` field, cleared on answer) so the UI
and watch can render them.

**Journal.** No shape change required — the existing `JournalEntry`
(`seq, key, text, data, outputTokens`) holds the answer with `outputTokens: 0`. Resume seeds
the journal as today, so answered questions short-circuit on lookup.

### Authoring entrypoint — `packages/workflow`

- Export an `askUserQuestion` stub + `AskUserQuestionOptions` type (typed `key`, `question`,
  `choices`, `allowOther`, `default`).
- Inject `runtime.askUserQuestion` into the sandbox globals (`loader.ts` globals object +
  `sandbox.ts` context). The stub is strip-and-replace like the other primitives.

### Foreground UI — `packages/ui`

- New `QuestionPrompt.tsx`: renders `question` as markdown, lists `choices` with arrow-key
  selection, and — when `allowOther` — an "Other" entry that reveals a **minimal custom
  text input** built on Ink's `useInput` (~40 lines: char append, backspace, enter-to-submit,
  arrows to move between choices). **No new dependency.**
- When `RunState.pendingQuestion` is set, `App.tsx` overlays/swaps to the prompt and routes
  keypresses to it instead of nav.
- On submit, dispatch a new `UiAction` `{ type: "answer"; key; value }` through the existing
  `onAction` callback.

### CLI wiring — `packages/cli`

- `execute.ts` `runForeground`: provide `askUser` to the runtime. It returns a Promise that is
  parked in a `Map<key, resolve>`; the `onAction` handler for `{ type: "answer" }` looks up and
  resolves it. Emits flow through `emit()` to the registry + listeners as usual.
- **Headless (`runHeadless` / `--detach` / non-TTY / CI):** provide an `askUser` that resolves
  from a **pre-supplied answers map** (`--answers '{"deploy-target":"staging"}'`), else the
  question's `default`, else returns a failed `Result` → `WorkflowError` ("unanswered question
  `<key>` in non-interactive run"). Add `--answers` parsing to `run.ts`; thread the map onto
  the run meta so detached children read it back.
- **Non-TTY line-log (`line-log.ts`):** format `question-asked` as `? <key>: <question
  first line>` and `question-answered` as `  ↳ <answer>`.
- **Watch (read-only):** render asked/answered in the event stream display; watch does **not**
  answer (consistent with today's read-only model) — that's the headless `--answers` path's job.

### Sandbox / determinism

No nondeterministic globals introduced. The answer enters via the event/handler boundary and
is journaled, so replay is byte-identical. The serialization lock is deterministic (FIFO by
acquisition order, which is itself seq-ordered).

## Edge cases

- **Stopped while waiting:** the question was never journaled (no answer yet), so resume
  re-asks — correct.
- **`allowOther` empty submit:** treat as no answer; keep the prompt open (or fall to
  `default` only in headless).
- **`choices` + `default` not in `choices`:** allowed; `default` is a headless fallback, not a
  UI constraint.
- **Question inside `parallel()`:** allowed; serialized behind the lock. Document that ordering
  among concurrent questions follows seq acquisition.
- **Duplicate `key`s:** last-writer journaling is by seq, not key, so two calls with the same
  `key` still journal independently; `--answers[key]` resolves both to the same value (likely
  the desired behavior). Note in docs.

## Visualization / UI

- **Foreground TTY:** markdown question panel + selectable choices + optional inline text
  field. Footer hint updates to `↑↓ select · ⏎ submit · type for Other`.
- **Non-TTY:** single `?`/`↳` log lines.
- **Watch:** asked/answered shown inline, read-only.

## Scope

### MVP (this work — author chose the full slice)

- [x] **Core:** `askUserQuestion()` primitive (shared seq + journal + serialization lock,
      skips budget/cap gates), `question-asked`/`question-answered` events, `reduce()` +
      `RunState.pendingQuestion`, replay test (answered question is not re-asked).
- [x] **Authoring:** stub + types in `packages/workflow`, sandbox injection.
- [x] **Foreground Ink prompt:** `QuestionPrompt.tsx` (markdown + choices + custom text input),
      `UiAction {type:'answer'}`, `execute.ts` wiring.
- [x] **Headless safety:** `--answers` map parsing, per-question `default`, fail-fast
      `WorkflowError` on unanswered non-interactive question.
- [x] **Non-TTY line-log + watch display.**

### Future enhancements

- [ ] Batched questions (1–4 per call) with a multi-field form screen.
- [ ] Schema-validated answers (`schema: z.object({...})`) reusing `@workflow/schema`.
- [ ] Make `watch` interactive so an attached watcher can answer a detached run (IPC).
- [ ] Answer history / "edit previous answer" affordance.

## Status

**Status:** Spec Complete
**Created:** 2026-05-30
**Priority:** P2 · effort M (ATOM-5)
