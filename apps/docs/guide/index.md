# What is defineworkflow?

<p class="wf-eyebrow">deterministic multi-agent workflow engine</p>

**defineworkflow** is a deterministic, crash-safe engine for orchestrating coding agents. A *workflow* is a
TypeScript file — no DSL, no YAML — that imports from the `defineworkflow` package and exports a
`defineWorkflow({ ..., run() })`, calling a handful of primitives to fan work out across agents and
fold the results back together. The engine makes that workflow **durable** (every result is journaled
and replayable), **observable** (a typed event stream drives the UI), and **concurrent** (a semaphore
throttles how many agents run at once).

> You don't call models directly. You describe orchestration; the engine runs your script inside a
> sandbox and hands it a `Runtime` of primitives.

## Why a separate engine?

Most agent orchestration today is welded to a single vendor's coding agent: you get the orchestration
only if you commit to that one model and that one CLI. **defineworkflow** inverts that — the engine is the
constant, and the *harness is a choice*. The same script, the same `agent()` / `parallel()` /
`pipeline()` calls, runs on the Claude CLI, the Codex CLI, the Copilot CLI, or the raw Anthropic API.
Change one line — `meta.harness` — and nothing else moves.

And you don't have to pick just one. A single run can **combine harnesses**: declare a default in
`meta.harness`, then send individual agents to a different backend per call with the `adapter` option.

```ts
phase("Generate")
const draft = await agent("Write the migration.", { schema: PATCH })   // runs on meta.harness

phase("Review")
const review = await agent("Audit this patch for regressions.", {
  adapter: "codex",                                                    // ← this one runs on Codex
  schema: VERDICT,
})
```

Use the model that's best (or cheapest) for each step, cross-check one harness's output against
another, or route around whatever isn't installed — all inside one deterministic, journaled run. No
lock-in to a single agent vendor.

## The mental model

<RoughDiagram
  direction="LR"
  caption="resume replays the journal — matching seqs return instantly, free"
  :nodes="[
    { id: 'script', label: 'script.ts' },
    { id: 'a1', label: 'agent()', accent: 'amber' },
    { id: 'a2', label: 'agent()', accent: 'amber' },
    { id: 'a3', label: 'agent()', accent: 'amber' },
    { id: 'journal', label: 'journal', sub: 'seq → result' },
    { id: 'reduce', label: 'reduce(events)' },
    { id: 'state', label: 'RunState' },
    { id: 'ui', label: 'UI', accent: 'cyan' },
  ]"
  :edges="[
    ['script', 'a1'], ['script', 'a2'], ['script', 'a3'],
    ['a1', 'journal'], ['a2', 'journal'], ['a3', 'journal'],
    ['journal', 'reduce'], ['reduce', 'state'], ['state', 'ui'],
  ]"
/>

A run walks your script top-to-bottom. Each `agent()` call is assigned a **sequence number**, does
its work through a pluggable **harness adapter**, and records its result in the **journal** keyed by
that seq. Re-running replays the journal: matching seqs return instantly, so a crashed or edited run
resumes from the longest unchanged prefix without re-invoking the model.

## The primitives

You import these from the `defineworkflow` package for autocomplete and compile-time checks; at run time
the engine strips that import and injects the live runtime values into your sandbox:

| Primitive | What it does |
|---|---|
| `agent(prompt, opts?)` | Run one agent. With a `schema`, returns validated structured output. The unit of work. |
| `parallel(thunks)` | **Barrier** — run all thunks concurrently, await every one. Failures become `null`. |
| `pipeline(items, ...stages)` | **No barrier** — each item flows through all stages independently. |
| `phase(title)` | Group subsequent agents under a named phase (drives the progress UI). |
| `log(message)` | Emit a log line into the event stream. |
| `workflow(name, args?)` | Run another workflow inline (one level deep; shares the parent budget). |
| `askUserQuestion(opts)` | **Pause and ask the human** a markdown question mid-run; returns their answer as a `string`. Journaled like an agent result, so resume never re-asks. |
| `args` / `budget` | The run's input value, and the soft token-budget gate. |

## A first workflow

```ts
import { agent, defineWorkflow, parallel, phase } from "defineworkflow"

export default defineWorkflow({
  name: "research-bugs",
  description: "Find bugs across the codebase, then verify each one",
  harness: "claude",
  phases: [{ title: "Find" }, { title: "Verify" }],

  async run() {
    phase("Find")
    const found = await agent("List suspicious files.", { schema: BUGS })

    phase("Verify")
    const checked = await parallel(
      found.bugs.map((b) => () => agent(`Is this real? ${b.desc}`, { schema: VERDICT })),
    )

    return checked.filter(Boolean).filter((v) => v.real)
  },
})
```

Two things make this honest engineering rather than a prompt toy:

- **`meta.harness` sets the default backend** — there is no auto-detect and no CLI override of it,
  though any single `agent()` call can opt into a different `adapter` (see [Why a separate
  engine?](#why-a-separate-engine)). The phases are seeded up front so the UI shows the whole pipeline
  before it runs.
- **The script must be deterministic.** That's enforced by the [sandbox](/guide/sandbox): `Date.now()`,
  `Math.random()`, and argless `new Date()` are hard-banned, because replay depends on the same calls
  happening in the same order.

## Asking the human a question

Sometimes a run needs a decision only a human can make — which environment to deploy to, which of two
drafts to keep. `askUserQuestion()` pauses the run, renders a markdown question in the terminal, and
returns the answer as a `string`. Because the question text is built from whatever's in scope, it's
naturally *a function of current state*:

```ts
import { agent, askUserQuestion, defineWorkflow, phase } from "defineworkflow"

export default defineWorkflow({
  name: "deploy",
  description: "Ask where to ship, then ship there",
  harness: "claude",

  async run() {
    const target = await askUserQuestion({
      key: "deploy-target",                 // stable key — used for --answers and the journal
      question: "## Where to deploy?\nPick the target environment.",
      choices: ["staging", "production"],   // arrow-key selectable
      allowOther: true,                      // adds an "Other → type your own" free-text path
      default: "staging",                    // used in non-interactive runs
    })

    return agent(`Deploy to ${target}.`)
  },
})
```

The answer is **journaled by sequence number**, exactly like an `agent()` result — so a resumed or
replayed run returns the cached answer instead of re-prompting. The call shares the agent seq counter
and skips the budget/cap gates (a question costs no tokens). Questions raised concurrently inside
`parallel()` / `pipeline()` are serialized behind one lock so only one prompt owns the keyboard at a
time; in-flight agents keep running.

**Headless runs never hang.** With no TTY (CI, `--detach`, non-interactive), the answer is resolved
from the [`--answers`](/cli#asking-questions-headlessly) map, then the question's `default`, and if
neither matches the run fails fast rather than blocking on input.

## Where to go next

Each page below is an interactive walkthrough built from the real source of `@workflow/core`:

- **[The agent() lifecycle](/guide/agent-lifecycle)** — the 13 steps every call walks. Start here.
- **[Journal & resume](/guide/journal-resume)** — why resume costs zero tokens.
- **[Concurrency & the semaphore](/guide/concurrency)** — how N-at-a-time is enforced.
- **[parallel() vs pipeline()](/guide/parallel-pipeline)** — the barrier, visualized.
- **[Events & RunState](/guide/events)** — the one observable.
- **[The sandbox](/guide/sandbox)** — determinism as a contract.
