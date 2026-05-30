# Events & RunState

<p class="wf-eyebrow">packages/core/src/events.ts</p>

The runtime emits a typed `WorkflowEvent` stream — and that's the *only* observable. There are no side
channels. A pure `reduce(state, event)` folds the stream into `RunState`, which is exactly what the Ink
UI, the persisted registry, and resume all consume. Press **emit** and watch state build from events.

<RoughDiagram
  direction="LR"
  caption="one observable — no side channels; the same pure fold drives every consumer"
  :nodes="[
    { id: 'rt', label: 'runtime', sub: 'emit()' },
    { id: 'ev', label: 'WorkflowEvent', sub: 'typed stream', accent: 'amber' },
    { id: 'reduce', label: 'reduce(state, ev)', sub: 'pure fold' },
    { id: 'state', label: 'RunState', accent: 'cyan' },
    { id: 'ui', label: 'Ink UI', accent: 'cyan' },
    { id: 'reg', label: 'registry', sub: 'resume' },
  ]"
  :edges="[
    ['rt', 'ev'],
    ['ev', 'reduce'],
    ['reduce', 'state'],
    ['state', 'ui'],
    ['state', 'reg'],
  ]"
/>

<EventStream />

## The event union

Everything the runtime does surfaces as one of these:

```ts
type WorkflowEvent =
  | { type: "run-started"; runId; name; at }
  | { type: "phase-started"; phase; at }
  | { type: "agent-queued"; key; label; phase; prompt?; at }
  | { type: "agent-started"; key; at }
  | { type: "agent-tool"; key; tool; at }
  | { type: "agent-output"; key; chunk; at }
  | { type: "agent-finished"; key; usage; cached; at }
  | { type: "agent-failed"; key; error; at }
  | { type: "question-asked"; key; question; choices?; allowOther?; at }
  | { type: "question-answered"; key; answer; cached; at }
  | { type: "log"; message; at }
  | { type: "run-finished"; runId; at }
```

## Why a pure reducer

Because `RunState` is a pure fold over events, the same reducer rebuilds state from a **live** stream
(the running UI) or a **replayed** one (open a finished run with `defineworkflow watch`). Note the
`cached` flag on `agent-finished`: a journal replay still emits the event, but the reducer doesn't
decrement `running` for it — so resumed runs account correctly.

```js
case "agent-finished": {
  const tokens = event.usage.inputTokens + event.usage.outputTokens;
  return { ...state,
    totalTokens: state.totalTokens + tokens,
    phases: upsertPhase(state.phases, a.phase, (p) => ({
      ...p, done: p.done + 1,
      running: Math.max(0, p.running - (event.cached ? 0 : 1)),
      tokens: p.tokens + tokens })) };
}
```

**The rule for extending the engine:** new runtime behavior surfaces through *events*, never a side
channel. If the UI or registry needs to know about it, it's an event.
