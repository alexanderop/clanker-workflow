# Workflow Engine — Plan 3: `@workflow/ui` (Ink Miller-columns TUI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@workflow/ui` — an Ink Miller-columns / master-detail TUI that is a pure function of the workflow event stream: a phases column, an agents column for the selected phase, and a live detail pane (prompt, tool calls, streaming result), with full keybinding parity (`↑↓ ←→ esc j/k p x r s`), render throttling, agent-list virtualization, and a non-TTY plain line-log fallback.

**Architecture:** The UI folds the existing `@workflow/core` `WorkflowEvent[]` into `RunState` with the core `reduce` reducer, then renders. All view logic (formatting, selectors, navigation state machine, line-log) is pure and unit-tested with no React. Ink components are thin renderers tested with `ink-testing-library`. The effectful entry (`startUi`) subscribes to an event source, accumulates events, throttles re-renders, and degrades to a line-log when stdout is not a TTY. A small, clearly-delimited Phase 0 extends the core event model with the two fields the detail pane needs (`prompt`, `resultText`).

**Tech Stack:** React 18, Ink 5, `ink-testing-library` 4, Vitest, TypeScript strict (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), tsup, oxlint. Builds on `@workflow/core`.

> **Naming note:** packages use the placeholder scope `@workflow/*`. Rename the scope before publishing.

> **Strict-mode gotchas this plan honors:**
> - `verbatimModuleSyntax: true` → every type-only import MUST use `import type`. Value imports (`Box`, `Text`, `useInput`, hooks, `createElement`) stay regular.
> - `exactOptionalPropertyTypes: true` → an optional prop a parent may pass `undefined` to must be typed `prop?: T | undefined`, not `prop?: T`. This plan types such props explicitly.
> - `noUncheckedIndexedAccess: true` → array/tuple index access is `T | undefined`; guard every computed index with `?? fallback`.
> - JSX: the React **automatic** runtime is used (no `import React`). The root `vitest.config.ts` gets `esbuild: { jsx: "automatic" }` so `.test.tsx` files transform; the package `tsconfig.json` sets `"jsx": "react-jsx"` so `tsup`/`tsc` compile `.tsx`.

---

## File Structure (Plan 3)

```
workflow/
├─ vitest.config.ts                   # MODIFY: add esbuild.jsx = "automatic"
└─ packages/
   ├─ core/
   │  └─ src/
   │     ├─ events.ts                 # MODIFY: + prompt on agent-queued, + agent-output, + AgentState.prompt/resultText
   │     ├─ events.test.ts            # (unchanged — still green)
   │     ├─ runtime.ts                # MODIFY: emit prompt on queued + agent-output before finished
   │     └─ runtime.test.ts           # MODIFY: event-sequence assertion gains "agent-output"
   └─ ui/
      ├─ package.json
      ├─ tsconfig.json                # jsx: react-jsx
      └─ src/
         ├─ index.ts                  # public exports
         ├─ format.ts                 # formatTokens, formatElapsed, statusGlyph, SPINNER_FRAMES
         ├─ format.test.ts
         ├─ selectors.ts              # orderedPhases, agentsInPhase, detailLines, elapsedMs
         ├─ selectors.test.ts
         ├─ navigation.ts             # NavState, NavAction, navReducer, initialNav
         ├─ navigation.test.ts
         ├─ line-log.ts               # lineLogLine (non-TTY fallback)
         ├─ line-log.test.ts
         ├─ throttle.ts               # injectable-clock throttle for re-renders
         ├─ throttle.test.ts
         ├─ Spinner.tsx               # frame-driven spinner (deterministic)
         ├─ Header.tsx                # top summary bar
         ├─ Header.test.tsx
         ├─ PhasesColumn.tsx          # left column
         ├─ PhasesColumn.test.tsx
         ├─ AgentsColumn.tsx          # middle column (windowed/virtualized)
         ├─ AgentsColumn.test.tsx
         ├─ DetailPane.tsx            # right column (scrollable)
         ├─ DetailPane.test.tsx
         ├─ App.tsx                   # composes columns + useInput → nav/actions
         ├─ App.test.tsx
         ├─ render.ts                 # startUi entry (TTY → ink, else line-log)
         └─ render.test.ts
```

**Dependency rule:** `@workflow/ui` depends only on `@workflow/core` (types + `reduce`/`initialRunState`), plus `react`/`ink`. It performs no fs/process work of its own except writing to a provided/`process.stdout` sink in the line-log fallback (an edge effect, isolated to `render.ts`).

---

## Phase 0 — Core event-model extension for detail rendering

The detail pane (spec §8) shows **PROMPT**, **TOOL CALLS**, and a streaming **RESULT**. `RunState.agents` already carries `tools`, but has no `prompt` or result text. This phase adds exactly those two fields end-to-end (event → reducer → state → runtime emit). Both changes are additive and keep `WorkflowError`/existing event variants stable.

### Task 1: Carry the agent prompt through the event model

**Files:**
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/runtime.ts:62`
- Test: `packages/core/src/events.test.ts` (add a case)

- [ ] **Step 1: Add the failing test to `packages/core/src/events.test.ts`**

Append this `it` block inside the existing `describe("event reducer", …)`:

```ts
  it("stores the prompt from agent-queued on the agent state", () => {
    const events: WorkflowEvent[] = [
      { type: "agent-queued", key: "0", label: "a", phase: "Search", prompt: "Search the web for X", at: 0 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.agents.get("0")?.prompt).toBe("Search the web for X");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/events.test.ts`
Expected: FAIL — `prompt` is not on the `agent-queued` event type / `state.agents.get("0")?.prompt` is `undefined` (type error or assertion failure).

- [ ] **Step 3: Edit `packages/core/src/events.ts`**

Add `prompt` to the `agent-queued` variant (line 17). Replace:

```ts
  | { readonly type: "agent-queued"; readonly key: string; readonly label: string; readonly phase: string; readonly at: number }
```

with:

```ts
  | { readonly type: "agent-queued"; readonly key: string; readonly label: string; readonly phase: string; readonly prompt?: string; readonly at: number }
```

Add `prompt` and `resultText` to `AgentState` (after `phase`):

```ts
export interface AgentState {
  readonly key: string;
  readonly label: string;
  readonly phase: string;
  readonly prompt: string;
  readonly resultText: string;
  readonly status: AgentStatus;
  readonly tokens: number;
  readonly tools: readonly ToolEvent[];
}
```

In the `agent-queued` reducer case, set both fields when creating the agent:

```ts
    case "agent-queued": {
      const agents = new Map(state.agents);
      agents.set(event.key, {
        key: event.key,
        label: event.label,
        phase: event.phase,
        prompt: event.prompt ?? "",
        resultText: "",
        status: "queued",
        tokens: 0,
        tools: [],
      });
      return {
        ...state,
        agents,
        phases: upsertPhase(state.phases, event.phase, (p) => ({ ...p, total: p.total + 1 })),
      };
    }
```

- [ ] **Step 4: Edit `packages/core/src/runtime.ts:62` to emit the prompt**

Replace:

```ts
    deps.emit({ type: "agent-queued", key, label, phase, at: deps.now() });
```

with:

```ts
    deps.emit({ type: "agent-queued", key, label, phase, prompt, at: deps.now() });
```

(`prompt` is the first parameter of the `agent` function already in scope.)

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/core/src/events.test.ts`
Expected: PASS (the new case + all existing cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/events.test.ts packages/core/src/runtime.ts
git commit -m "feat(core): carry agent prompt through event model for UI detail pane"
```

### Task 2: Stream agent result text via an `agent-output` event

**Files:**
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/runtime.ts` (cached path ~line 66, live path ~line 135)
- Modify: `packages/core/src/runtime.test.ts:52` (event-sequence assertion)
- Test: `packages/core/src/events.test.ts` (add a case)

- [ ] **Step 1: Add the failing reducer test to `packages/core/src/events.test.ts`**

Append inside `describe("event reducer", …)`:

```ts
  it("accumulates agent-output chunks into resultText", () => {
    const events: WorkflowEvent[] = [
      { type: "agent-queued", key: "0", label: "a", phase: "P", at: 0 },
      { type: "agent-output", key: "0", chunk: "hello ", at: 1 },
      { type: "agent-output", key: "0", chunk: "world", at: 2 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.agents.get("0")?.resultText).toBe("hello world");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/events.test.ts`
Expected: FAIL — `agent-output` is not a known event type.

- [ ] **Step 3: Edit `packages/core/src/events.ts`**

Add a new variant to the `WorkflowEvent` union (place it directly after the `agent-tool` line):

```ts
  | { readonly type: "agent-output"; readonly key: string; readonly chunk: string; readonly at: number }
```

Add a `case` to `reduce` (place it directly after the `agent-tool` case). The `reduce` switch is exhaustive over the union with no `default`, so the union and the switch must stay in sync:

```ts
    case "agent-output": {
      const a = state.agents.get(event.key);
      if (!a) return state;
      const agents = new Map(state.agents);
      agents.set(event.key, { ...a, resultText: a.resultText + event.chunk });
      return { ...state, agents };
    }
```

- [ ] **Step 4: Run to verify the reducer test passes**

Run: `pnpm vitest run packages/core/src/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Emit `agent-output` from the runtime (cached + live paths)**

In `packages/core/src/runtime.ts`, the cached-resume branch (~line 66) currently reads:

```ts
    const cached = deps.journal.lookup(mySeq);
    if (cached) {
      budget.record(cached.outputTokens);
      deps.emit({ type: "agent-finished", key, usage: { inputTokens: 0, outputTokens: cached.outputTokens }, cached: true, at: deps.now() });
      return cached.data ?? cached.text;
    }
```

Insert an `agent-output` emit before the `agent-finished` emit so resumed agents populate the detail pane too:

```ts
    const cached = deps.journal.lookup(mySeq);
    if (cached) {
      budget.record(cached.outputTokens);
      deps.emit({ type: "agent-output", key, chunk: cached.text, at: deps.now() });
      deps.emit({ type: "agent-finished", key, usage: { inputTokens: 0, outputTokens: cached.outputTokens }, cached: true, at: deps.now() });
      return cached.data ?? cached.text;
    }
```

In the live branch, just before the final `agent-finished` emit (~line 136, after `deps.journal.record({ … })`), add:

```ts
      deps.emit({ type: "agent-output", key, chunk: res.text, at: deps.now() });
```

so the ordering becomes `journal.record(...)` → `agent-output` → `agent-finished`.

> Note: adapters in Plan 2 return a complete `AgentResult.text` (not incremental chunks), so v1 emits one `agent-output` carrying the full text. The reducer already supports many chunks, so genuine streaming is a drop-in later (emit multiple `agent-output` events) with no UI change.

- [ ] **Step 6: Update the event-sequence assertion in `packages/core/src/runtime.test.ts:52`**

The "emits queued/started/finished events" test asserts the exact sequence. Replace:

```ts
    expect(types).toEqual(["phase-started", "agent-queued", "agent-started", "agent-finished"]);
```

with:

```ts
    expect(types).toEqual(["phase-started", "agent-queued", "agent-started", "agent-output", "agent-finished"]);
```

- [ ] **Step 7: Run the full core suite to confirm nothing else regressed**

Run: `pnpm vitest run packages/core`
Expected: PASS (all core tests, including `runtime.test.ts` and the resume/limits/nested suites — none of those assert exact full sequences except the one updated above; resume tests assert `callCount`/values, unaffected).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/events.test.ts packages/core/src/runtime.ts packages/core/src/runtime.test.ts
git commit -m "feat(core): agent-output event accumulating resultText for UI detail pane"
```

---

## Phase 1 — `@workflow/ui` scaffold

### Task 3: Package skeleton + JSX wiring

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/src/index.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Create `packages/ui/package.json`**

```json
{
  "name": "@workflow/ui",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean --external react --external ink",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@workflow/core": "workspace:*",
    "ink": "^5.0.1",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "ink-testing-library": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/ui/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create placeholder `packages/ui/src/index.ts`**

```ts
export {};
```

- [ ] **Step 4: Add `esbuild.jsx` to `vitest.config.ts`** so `.test.tsx` files transform with the automatic runtime

Replace the file contents with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    coverage: { provider: "v8", reporter: ["text", "html"] },
  },
});
```

- [ ] **Step 5: Install deps**

Run: `pnpm install`
Expected: installs `react`, `ink`, `@types/react`, `ink-testing-library` into `packages/ui`; links `@workflow/core` via `workspace:*`.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/package.json packages/ui/tsconfig.json packages/ui/src/index.ts vitest.config.ts pnpm-lock.yaml
git commit -m "chore(ui): scaffold @workflow/ui package + vitest JSX wiring"
```

---

## Phase 2 — Pure view logic (no React)

### Task 4: Formatting helpers + spinner frames + status glyphs

**Files:**
- Create: `packages/ui/src/format.ts`
- Test: `packages/ui/src/format.test.ts`

- [ ] **Step 1: Write the failing test `packages/ui/src/format.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { formatTokens, formatElapsed, statusGlyph, SPINNER_FRAMES } from "./format.js";

describe("formatTokens", () => {
  it("passes through small counts and abbreviates thousands/decimals", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(44000)).toBe("44k");
    expect(formatTokens(318000)).toBe("318k");
  });
});

describe("formatElapsed", () => {
  it("renders seconds, and minutes+padded-seconds past a minute", () => {
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(161000)).toBe("2m41s");
    expect(formatElapsed(600000)).toBe("10m00s");
  });
});

describe("statusGlyph", () => {
  it("maps statuses to glyphs and animates the running spinner by frame", () => {
    expect(statusGlyph("done")).toBe("✓");
    expect(statusGlyph("failed")).toBe("✗");
    expect(statusGlyph("queued")).toBe("▱");
    expect(statusGlyph("running", 0)).toBe(SPINNER_FRAMES[0]);
    expect(statusGlyph("running", SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/format.test.ts`
Expected: FAIL — cannot find `./format.js`.

- [ ] **Step 3: Create `packages/ui/src/format.ts`**

```ts
import type { AgentStatus } from "@workflow/core";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${rounded}k`;
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

export function statusGlyph(status: AgentStatus, frame = 0): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "queued":
      return "▱";
    case "running":
      return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/format.ts packages/ui/src/format.test.ts
git commit -m "feat(ui): token/elapsed formatting + status glyphs + spinner frames"
```

### Task 5: Selectors over `RunState`

**Files:**
- Create: `packages/ui/src/selectors.ts`
- Test: `packages/ui/src/selectors.test.ts`

- [ ] **Step 1: Write the failing test `packages/ui/src/selectors.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { reduce, initialRunState, type WorkflowEvent } from "@workflow/core";
import { orderedPhases, agentsInPhase, detailLines, elapsedMs } from "./selectors.js";

const events: WorkflowEvent[] = [
  { type: "run-started", runId: "r1", name: "demo", at: 100 },
  { type: "phase-started", phase: "Scope", at: 110 },
  { type: "phase-started", phase: "Search", at: 120 },
  { type: "agent-queued", key: "k0", label: "angle-0", phase: "Search", prompt: "find a\nfind b", at: 130 },
  { type: "agent-tool", key: "k0", tool: { name: "WebSearch" }, at: 140 },
  { type: "agent-output", key: "k0", chunk: "result line 1", at: 150 },
  { type: "agent-finished", key: "k0", usage: { inputTokens: 1, outputTokens: 9 }, cached: false, at: 160 },
];
const state = events.reduce(reduce, initialRunState());

describe("selectors", () => {
  it("orderedPhases preserves insertion order", () => {
    expect(orderedPhases(state).map((p) => p.title)).toEqual(["Scope", "Search"]);
  });

  it("agentsInPhase returns only that phase's agents", () => {
    expect(agentsInPhase(state, "Search").map((a) => a.label)).toEqual(["angle-0"]);
    expect(agentsInPhase(state, "Scope")).toEqual([]);
  });

  it("detailLines lays out PROMPT / TOOL CALLS / RESULT sections", () => {
    const agent = agentsInPhase(state, "Search")[0]!;
    expect(detailLines(agent)).toEqual([
      "PROMPT",
      "find a",
      "find b",
      "",
      "TOOL CALLS",
      "• WebSearch",
      "",
      "RESULT",
      "result line 1",
    ]);
  });

  it("elapsedMs is last event at minus first event at", () => {
    expect(elapsedMs(events)).toBe(60);
    expect(elapsedMs([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/selectors.test.ts`
Expected: FAIL — cannot find `./selectors.js`.

- [ ] **Step 3: Create `packages/ui/src/selectors.ts`**

```ts
import type { RunState, AgentState, PhaseState, WorkflowEvent } from "@workflow/core";

export function orderedPhases(state: RunState): readonly PhaseState[] {
  return [...state.phases.values()];
}

export function agentsInPhase(state: RunState, phase: string): readonly AgentState[] {
  return [...state.agents.values()].filter((a) => a.phase === phase);
}

export function detailLines(agent: AgentState): readonly string[] {
  return [
    "PROMPT",
    ...agent.prompt.split("\n"),
    "",
    "TOOL CALLS",
    ...agent.tools.map((t) => `• ${t.name}`),
    "",
    "RESULT",
    ...agent.resultText.split("\n"),
  ];
}

export function elapsedMs(events: readonly WorkflowEvent[]): number {
  if (events.length === 0) return 0;
  const start = events[0]?.at ?? 0;
  const end = events[events.length - 1]?.at ?? start;
  return Math.max(0, end - start);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/selectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/selectors.ts packages/ui/src/selectors.test.ts
git commit -m "feat(ui): pure selectors (phases, agents-of-phase, detail lines, elapsed)"
```

### Task 6: Navigation state machine

**Files:**
- Create: `packages/ui/src/navigation.ts`
- Test: `packages/ui/src/navigation.test.ts`

- [ ] **Step 1: Write the failing test `packages/ui/src/navigation.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { navReducer, initialNav, type NavCtx } from "./navigation.js";

const ctx: NavCtx = { phaseCount: 3, agentCount: 5, maxScroll: 4 };

describe("navReducer", () => {
  it("starts focused on phases at index 0", () => {
    expect(initialNav).toEqual({ focus: "phases", phaseIndex: 0, agentIndex: 0, scroll: 0 });
  });

  it("down/up move and clamp the phase selection while focused on phases", () => {
    const a = navReducer(initialNav, { type: "down" }, ctx);
    expect(a.phaseIndex).toBe(1);
    const top = navReducer(initialNav, { type: "up" }, ctx);
    expect(top.phaseIndex).toBe(0); // clamped at 0
    const last = [...Array(10)].reduce((s) => navReducer(s, { type: "down" }, ctx), initialNav);
    expect(last.phaseIndex).toBe(2); // clamped at phaseCount - 1
  });

  it("changing the phase resets agent selection and scroll", () => {
    const moved = navReducer({ focus: "phases", phaseIndex: 0, agentIndex: 3, scroll: 2 }, { type: "down" }, ctx);
    expect(moved).toMatchObject({ phaseIndex: 1, agentIndex: 0, scroll: 0 });
  });

  it("right/left move focus across columns; esc jumps back to phases", () => {
    const toAgents = navReducer(initialNav, { type: "right" }, ctx);
    expect(toAgents.focus).toBe("agents");
    const toDetail = navReducer(toAgents, { type: "right" }, ctx);
    expect(toDetail.focus).toBe("detail");
    const stillDetail = navReducer(toDetail, { type: "right" }, ctx);
    expect(stillDetail.focus).toBe("detail"); // no column past detail
    const backToAgents = navReducer(toDetail, { type: "left" }, ctx);
    expect(backToAgents.focus).toBe("agents");
    expect(navReducer(toDetail, { type: "esc" }, ctx).focus).toBe("phases");
  });

  it("down/up move and clamp the agent selection while focused on agents", () => {
    const onAgents = { focus: "agents" as const, phaseIndex: 0, agentIndex: 0, scroll: 0 };
    expect(navReducer(onAgents, { type: "down" }, ctx).agentIndex).toBe(1);
    const last = [...Array(10)].reduce((s) => navReducer(s, { type: "down" }, ctx), onAgents);
    expect(last.agentIndex).toBe(4); // clamped at agentCount - 1
  });

  it("scrollDown/scrollUp move and clamp the detail scroll within maxScroll", () => {
    const s1 = navReducer(initialNav, { type: "scrollDown" }, ctx);
    expect(s1.scroll).toBe(1);
    const max = [...Array(10)].reduce((s) => navReducer(s, { type: "scrollDown" }, ctx), initialNav);
    expect(max.scroll).toBe(4); // clamped at maxScroll
    expect(navReducer(initialNav, { type: "scrollUp" }, ctx).scroll).toBe(0); // clamped at 0
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/navigation.test.ts`
Expected: FAIL — cannot find `./navigation.js`.

- [ ] **Step 3: Create `packages/ui/src/navigation.ts`**

```ts
export type FocusColumn = "phases" | "agents" | "detail";

export interface NavState {
  readonly focus: FocusColumn;
  readonly phaseIndex: number;
  readonly agentIndex: number;
  readonly scroll: number;
}

export type NavAction =
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "esc" }
  | { readonly type: "scrollUp" }
  | { readonly type: "scrollDown" };

export interface NavCtx {
  readonly phaseCount: number;
  readonly agentCount: number;
  readonly maxScroll: number;
}

export const initialNav: NavState = { focus: "phases", phaseIndex: 0, agentIndex: 0, scroll: 0 };

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function navReducer(state: NavState, action: NavAction, ctx: NavCtx): NavState {
  switch (action.type) {
    case "up":
      if (state.focus === "phases")
        return { ...state, phaseIndex: clamp(state.phaseIndex - 1, 0, Math.max(0, ctx.phaseCount - 1)), agentIndex: 0, scroll: 0 };
      if (state.focus === "agents")
        return { ...state, agentIndex: clamp(state.agentIndex - 1, 0, Math.max(0, ctx.agentCount - 1)), scroll: 0 };
      return state;
    case "down":
      if (state.focus === "phases")
        return { ...state, phaseIndex: clamp(state.phaseIndex + 1, 0, Math.max(0, ctx.phaseCount - 1)), agentIndex: 0, scroll: 0 };
      if (state.focus === "agents")
        return { ...state, agentIndex: clamp(state.agentIndex + 1, 0, Math.max(0, ctx.agentCount - 1)), scroll: 0 };
      return state;
    case "right":
      if (state.focus === "phases") return { ...state, focus: "agents" };
      if (state.focus === "agents") return { ...state, focus: "detail" };
      return state;
    case "left":
      if (state.focus === "detail") return { ...state, focus: "agents" };
      if (state.focus === "agents") return { ...state, focus: "phases" };
      return state;
    case "esc":
      return { ...state, focus: "phases" };
    case "scrollUp":
      return { ...state, scroll: clamp(state.scroll - 1, 0, ctx.maxScroll) };
    case "scrollDown":
      return { ...state, scroll: clamp(state.scroll + 1, 0, ctx.maxScroll) };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/navigation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/navigation.ts packages/ui/src/navigation.test.ts
git commit -m "feat(ui): pure navigation state machine (columns/selection/scroll)"
```

### Task 7: Line-log fallback formatter

**Files:**
- Create: `packages/ui/src/line-log.ts`
- Test: `packages/ui/src/line-log.test.ts`

- [ ] **Step 1: Write the failing test `packages/ui/src/line-log.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { WorkflowEvent } from "@workflow/core";
import { lineLogLine } from "./line-log.js";

describe("lineLogLine", () => {
  it("renders one line for human-meaningful events", () => {
    expect(lineLogLine({ type: "run-started", runId: "r1", name: "demo", at: 0 })).toBe("▶ demo (r1)");
    expect(lineLogLine({ type: "phase-started", phase: "Search", at: 0 })).toBe("# Search");
    expect(lineLogLine({ type: "agent-finished", key: "k0", usage: { inputTokens: 1, outputTokens: 9 }, cached: false, at: 0 })).toBe("  ✓ k0 (9 tok)");
    expect(lineLogLine({ type: "agent-finished", key: "k0", usage: { inputTokens: 0, outputTokens: 9 }, cached: true, at: 0 })).toBe("  ✓ k0 (9 tok, cached)");
    expect(lineLogLine({ type: "agent-failed", key: "k0", error: { kind: "BudgetExhausted", spent: 5, total: 5 }, at: 0 })).toBe("  ✗ k0 [BudgetExhausted]");
    expect(lineLogLine({ type: "log", message: "hi", at: 0 })).toBe("  hi");
    expect(lineLogLine({ type: "run-finished", runId: "r1", at: 0 })).toBe("■ done");
  });

  it("returns null for noisy events that don't warrant a line", () => {
    expect(lineLogLine({ type: "agent-queued", key: "k0", label: "a", phase: "P", at: 0 })).toBeNull();
    expect(lineLogLine({ type: "agent-output", key: "k0", chunk: "x", at: 0 })).toBeNull();
    expect(lineLogLine({ type: "agent-tool", key: "k0", tool: { name: "WebSearch" }, at: 0 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/line-log.test.ts`
Expected: FAIL — cannot find `./line-log.js`.

- [ ] **Step 3: Create `packages/ui/src/line-log.ts`**

```ts
import type { WorkflowEvent } from "@workflow/core";

export function lineLogLine(event: WorkflowEvent): string | null {
  switch (event.type) {
    case "run-started":
      return `▶ ${event.name} (${event.runId})`;
    case "phase-started":
      return `# ${event.phase}`;
    case "agent-started":
      return `  … ${event.key}`;
    case "agent-finished":
      return `  ✓ ${event.key} (${event.usage.outputTokens} tok${event.cached ? ", cached" : ""})`;
    case "agent-failed":
      return `  ✗ ${event.key} [${event.error.kind}]`;
    case "log":
      return `  ${event.message}`;
    case "run-finished":
      return "■ done";
    case "agent-queued":
    case "agent-output":
    case "agent-tool":
      return null;
  }
}
```

> Note: `agent-started` produces a line here (`… key`) but is omitted from the test's
> "noisy" list because a started marker is useful in a non-interactive log. The test
> above does not assert `agent-started`; both behaviors are intentional.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/line-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/line-log.ts packages/ui/src/line-log.test.ts
git commit -m "feat(ui): non-TTY line-log event formatter"
```

### Task 8: Re-render throttle (injectable clock)

**Files:**
- Create: `packages/ui/src/throttle.ts`
- Test: `packages/ui/src/throttle.test.ts`

- [ ] **Step 1: Write the failing test `packages/ui/src/throttle.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { throttle, type ThrottleDeps } from "./throttle.js";

function fakeDeps() {
  let clock = 0;
  const timers: Array<{ id: number; fn: () => void; at: number }> = [];
  let nextId = 1;
  const deps: ThrottleDeps = {
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, at: clock + ms });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn(); }
  };
  return { deps, advance, setClock: (n: number) => (clock = n) };
}

describe("throttle", () => {
  it("runs immediately on the leading edge", () => {
    const { deps } = fakeDeps();
    let calls = 0;
    const t = throttle(() => calls++, 100, deps);
    t.call();
    expect(calls).toBe(1);
  });

  it("coalesces rapid calls within the interval into a single trailing run", () => {
    const { deps, advance } = fakeDeps();
    let calls = 0;
    const t = throttle(() => calls++, 100, deps);
    t.call(); // leading → 1
    t.call();
    t.call(); // both within window → schedule one trailing
    expect(calls).toBe(1);
    advance(100); // trailing fires
    expect(calls).toBe(2);
  });

  it("allows a new leading run after the interval has fully elapsed", () => {
    const { deps, advance } = fakeDeps();
    let calls = 0;
    const t = throttle(() => calls++, 100, deps);
    t.call(); // 1
    advance(100);
    t.call(); // 2 (window elapsed → leading again)
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/throttle.test.ts`
Expected: FAIL — cannot find `./throttle.js`.

- [ ] **Step 3: Create `packages/ui/src/throttle.ts`**

```ts
export interface ThrottleDeps {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface Throttled {
  call(): void;
  cancel(): void;
}

/** Leading-edge throttle with a single trailing call; ~10fps when ms = 100. */
export function throttle(fn: () => void, ms: number, deps: ThrottleDeps): Throttled {
  let last = -Infinity;
  let timer: unknown = undefined;

  const invoke = (): void => {
    last = deps.now();
    timer = undefined;
    fn();
  };

  return {
    call() {
      const elapsed = deps.now() - last;
      if (elapsed >= ms) {
        invoke();
        return;
      }
      if (timer === undefined) timer = deps.setTimer(invoke, ms - elapsed);
    },
    cancel() {
      if (timer !== undefined) {
        deps.clearTimer(timer);
        timer = undefined;
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/throttle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/throttle.ts packages/ui/src/throttle.test.ts
git commit -m "feat(ui): leading-edge re-render throttle with injectable clock"
```

---

## Phase 3 — Ink components

### Task 9: Spinner + Header

**Files:**
- Create: `packages/ui/src/Spinner.tsx`
- Create: `packages/ui/src/Header.tsx`
- Test: `packages/ui/src/Header.test.tsx`

- [ ] **Step 1: Write the failing test `packages/ui/src/Header.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { reduce, initialRunState, type WorkflowEvent } from "@workflow/core";
import { Header } from "./Header.js";

const state = ([
  { type: "run-started", runId: "r1", name: "deep-research", at: 0 },
  { type: "agent-queued", key: "k", label: "a", phase: "Search", at: 1 },
  { type: "agent-finished", key: "k", usage: { inputTokens: 0, outputTokens: 318000 }, cached: false, at: 2 },
] satisfies WorkflowEvent[]).reduce(reduce, initialRunState());

describe("Header", () => {
  it("shows name, status, abbreviated tokens, elapsed and adapter", () => {
    const { lastFrame } = render(<Header state={state} elapsedMs={161000} adapter="codex" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deep-research");
    expect(frame).toContain("running");
    expect(frame).toContain("318k tok");
    expect(frame).toContain("2m41s");
    expect(frame).toContain("adapter:codex");
  });

  it("omits the adapter segment when none is given", () => {
    const { lastFrame } = render(<Header state={state} elapsedMs={0} />);
    expect(lastFrame() ?? "").not.toContain("adapter:");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/Header.test.tsx`
Expected: FAIL — cannot find `./Header.js`.

- [ ] **Step 3: Create `packages/ui/src/Spinner.tsx`**

```tsx
import { Text } from "ink";
import { SPINNER_FRAMES } from "./format.js";

export interface SpinnerProps {
  readonly frame: number;
}

export function Spinner({ frame }: SpinnerProps) {
  return <Text>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]}</Text>;
}
```

- [ ] **Step 4: Create `packages/ui/src/Header.tsx`**

```tsx
import { Box, Text } from "ink";
import type { RunState } from "@workflow/core";
import { formatTokens, formatElapsed } from "./format.js";

export interface HeaderProps {
  readonly state: RunState;
  readonly elapsedMs: number;
  readonly adapter?: string | undefined;
}

export function Header({ state, elapsedMs, adapter }: HeaderProps) {
  const name = state.name || "workflow";
  const adapterSegment = adapter ? ` · adapter:${adapter}` : "";
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>
        {name} · {state.status} · {formatTokens(state.totalTokens)} tok · {formatElapsed(elapsedMs)}
        {adapterSegment}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/Header.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/Spinner.tsx packages/ui/src/Header.tsx packages/ui/src/Header.test.tsx
git commit -m "feat(ui): Spinner + Header summary bar components"
```

### Task 10: PhasesColumn

**Files:**
- Create: `packages/ui/src/PhasesColumn.tsx`
- Test: `packages/ui/src/PhasesColumn.test.tsx`

- [ ] **Step 1: Write the failing test `packages/ui/src/PhasesColumn.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { PhaseState } from "@workflow/core";
import { PhasesColumn } from "./PhasesColumn.js";

const phases: PhaseState[] = [
  { title: "Scope", total: 1, done: 1, running: 0, tokens: 10 },
  { title: "Search", total: 5, done: 3, running: 1, tokens: 200 },
];

describe("PhasesColumn", () => {
  it("renders the PHASES header and each phase with done/total counts", () => {
    const { lastFrame } = render(<PhasesColumn phases={phases} selectedIndex={0} focused frame={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("PHASES");
    expect(frame).toContain("Scope 1/1");
    expect(frame).toContain("Search 3/5");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/PhasesColumn.test.tsx`
Expected: FAIL — cannot find `./PhasesColumn.js`.

- [ ] **Step 3: Create `packages/ui/src/PhasesColumn.tsx`**

```tsx
import { Box, Text } from "ink";
import type { PhaseState } from "@workflow/core";
import { Spinner } from "./Spinner.js";

export interface PhasesColumnProps {
  readonly phases: readonly PhaseState[];
  readonly selectedIndex: number;
  readonly focused: boolean;
  readonly frame: number;
}

export function PhasesColumn({ phases, selectedIndex, focused, frame }: PhasesColumnProps) {
  return (
    <Box flexDirection="column" width={24} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text bold>PHASES</Text>
      {phases.map((p, i) => (
        <Box key={p.title}>
          <Text inverse={i === selectedIndex}>
            {p.title} {p.done}/{p.total}{" "}
          </Text>
          {p.running > 0 ? <Spinner frame={frame} /> : null}
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/PhasesColumn.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/PhasesColumn.tsx packages/ui/src/PhasesColumn.test.tsx
git commit -m "feat(ui): PhasesColumn with selection + running spinner"
```

### Task 11: AgentsColumn (windowed/virtualized)

**Files:**
- Create: `packages/ui/src/AgentsColumn.tsx`
- Test: `packages/ui/src/AgentsColumn.test.tsx`

- [ ] **Step 1: Write the failing test `packages/ui/src/AgentsColumn.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { AgentState } from "@workflow/core";
import { AgentsColumn } from "./AgentsColumn.js";

function agent(label: string, status: AgentState["status"], tokens = 0): AgentState {
  return { key: label, label, phase: "Search", prompt: "", resultText: "", status, tokens, tools: [] };
}

describe("AgentsColumn", () => {
  it("shows the phase title and glyph+tokens per agent", () => {
    const agents = [agent("angle-0", "done", 18000), agent("angle-1", "running")];
    const { lastFrame } = render(<AgentsColumn agents={agents} selectedIndex={0} focused phaseTitle="Search" frame={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("AGENTS (Search)");
    expect(frame).toContain("✓ angle-0 18k");
    expect(frame).toContain("angle-1");
  });

  it("virtualizes: renders at most maxVisible rows, windowed around the selection", () => {
    const agents = Array.from({ length: 100 }, (_, i) => agent(`a${i}`, "queued"));
    const { lastFrame } = render(
      <AgentsColumn agents={agents} selectedIndex={50} focused phaseTitle="Search" frame={0} maxVisible={5} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a50"); // selection visible
    expect(frame).not.toContain("a0"); // far-away rows not rendered
    expect(frame).not.toContain("a99");
    const rendered = ["a48", "a49", "a50", "a51", "a52"].filter((l) => frame.includes(l));
    expect(rendered.length).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/AgentsColumn.test.tsx`
Expected: FAIL — cannot find `./AgentsColumn.js`.

- [ ] **Step 3: Create `packages/ui/src/AgentsColumn.tsx`**

```tsx
import { Box, Text } from "ink";
import type { AgentState } from "@workflow/core";
import { statusGlyph, formatTokens } from "./format.js";

export interface AgentsColumnProps {
  readonly agents: readonly AgentState[];
  readonly selectedIndex: number;
  readonly focused: boolean;
  readonly phaseTitle: string;
  readonly frame: number;
  readonly maxVisible?: number;
}

export function AgentsColumn({ agents, selectedIndex, focused, phaseTitle, frame, maxVisible = 10 }: AgentsColumnProps) {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, agents.length - maxVisible)));
  const visible = agents.slice(start, start + maxVisible);
  return (
    <Box flexDirection="column" width={30} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text bold>AGENTS ({phaseTitle})</Text>
      {visible.map((a, i) => {
        const index = start + i;
        return (
          <Text key={a.key} inverse={index === selectedIndex}>
            {statusGlyph(a.status, frame)} {a.label} {a.tokens > 0 ? formatTokens(a.tokens) : "—"}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/AgentsColumn.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/AgentsColumn.tsx packages/ui/src/AgentsColumn.test.tsx
git commit -m "feat(ui): AgentsColumn with windowed virtualization + status glyphs"
```

### Task 12: DetailPane (scrollable)

**Files:**
- Create: `packages/ui/src/DetailPane.tsx`
- Test: `packages/ui/src/DetailPane.test.tsx`

- [ ] **Step 1: Write the failing test `packages/ui/src/DetailPane.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { AgentState } from "@workflow/core";
import { DetailPane } from "./DetailPane.js";

const agent: AgentState = {
  key: "k0",
  label: "angle-0",
  phase: "Search",
  prompt: "line P",
  resultText: "R1\nR2\nR3\nR4",
  status: "running",
  tokens: 44000,
  tools: [{ name: "WebSearch" }],
};

describe("DetailPane", () => {
  it("renders prompt, tool calls and result when an agent is selected", () => {
    const { lastFrame } = render(<DetailPane agent={agent} scroll={0} rows={20} focused />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("PROMPT");
    expect(frame).toContain("line P");
    expect(frame).toContain("• WebSearch");
    expect(frame).toContain("RESULT");
    expect(frame).toContain("R1");
  });

  it("scrolls: a positive scroll offset hides leading lines", () => {
    const { lastFrame } = render(<DetailPane agent={agent} scroll={8} rows={3} focused />);
    const frame = lastFrame() ?? "";
    // lines: [PROMPT, line P, "", TOOL CALLS, • WebSearch, "", RESULT, R1, R2, R3, R4]
    // scroll=8 → window starts at "R2"
    expect(frame).toContain("R2");
    expect(frame).not.toContain("PROMPT");
    expect(frame).not.toContain("R1");
  });

  it("shows a placeholder when no agent is selected", () => {
    const { lastFrame } = render(<DetailPane agent={undefined} scroll={0} rows={5} focused={false} />);
    expect(lastFrame() ?? "").toContain("no agent selected");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/DetailPane.test.tsx`
Expected: FAIL — cannot find `./DetailPane.js`.

- [ ] **Step 3: Create `packages/ui/src/DetailPane.tsx`**

```tsx
import { Box, Text } from "ink";
import type { AgentState } from "@workflow/core";
import { detailLines } from "./selectors.js";

export interface DetailPaneProps {
  readonly agent: AgentState | undefined;
  readonly scroll: number;
  readonly rows: number;
  readonly focused: boolean;
}

export function DetailPane({ agent, scroll, rows, focused }: DetailPaneProps) {
  const lines = agent ? detailLines(agent) : ["(no agent selected)"];
  const visible = lines.slice(scroll, scroll + rows);
  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      {visible.map((line, i) => (
        <Text key={scroll + i}>{line === "" ? " " : line}</Text>
      ))}
    </Box>
  );
}
```

> Note: empty lines render as a single space so Ink keeps the blank row in the frame.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/DetailPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/DetailPane.tsx packages/ui/src/DetailPane.test.tsx
git commit -m "feat(ui): scrollable DetailPane (prompt/tools/result)"
```

### Task 13: App — compose columns + keybindings

**Files:**
- Create: `packages/ui/src/App.tsx`
- Test: `packages/ui/src/App.test.tsx`

- [ ] **Step 1: Write the failing test `packages/ui/src/App.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { WorkflowEvent } from "@workflow/core";
import { App, type UiAction } from "./App.js";

const events: WorkflowEvent[] = [
  { type: "run-started", runId: "r1", name: "deep-research", at: 0 },
  { type: "phase-started", phase: "Scope", at: 1 },
  { type: "phase-started", phase: "Search", at: 2 },
  { type: "agent-queued", key: "k0", label: "angle-0", phase: "Search", prompt: "Search X", at: 3 },
  { type: "agent-started", key: "k0", at: 4 },
  { type: "agent-output", key: "k0", chunk: "found stuff", at: 5 },
  { type: "agent-finished", key: "k0", usage: { inputTokens: 1, outputTokens: 17 }, cached: false, at: 6 },
];

const KEY = { down: "[B", up: "[A", right: "[C", left: "[D", esc: "" };

describe("App", () => {
  it("renders the header and all three columns from the event stream", () => {
    const { lastFrame } = render(<App events={events} adapter="codex" animate={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deep-research");
    expect(frame).toContain("PHASES");
    expect(frame).toContain("AGENTS");
    expect(frame).toContain("Scope 0/0");
    expect(frame).toContain("Search 1/1");
  });

  it("right-arrow focuses agents so the selected phase's agents show, then detail", () => {
    const { lastFrame, stdin } = render(<App events={events} animate={false} />);
    stdin.write(KEY.down); // select phase index 1 (Search)
    stdin.write(KEY.right); // focus agents
    expect(lastFrame() ?? "").toContain("AGENTS (Search)");
    expect(lastFrame() ?? "").toContain("angle-0");
    stdin.write(KEY.right); // focus detail
    expect(lastFrame() ?? "").toContain("found stuff");
  });

  it("emits pause/stop/save actions via onAction", () => {
    const actions: UiAction[] = [];
    const { stdin } = render(<App events={events} animate={false} onAction={(a) => actions.push(a)} />);
    stdin.write("p");
    stdin.write("x"); // focus is phases → stop whole run
    stdin.write("s");
    expect(actions).toEqual([
      { type: "pause" },
      { type: "stop", target: { scope: "run" } },
      { type: "save" },
    ]);
  });

  it("stop targets the selected agent when focus is on agents/detail", () => {
    const actions: UiAction[] = [];
    const { stdin } = render(<App events={events} animate={false} onAction={(a) => actions.push(a)} />);
    stdin.write(KEY.down); // Search
    stdin.write(KEY.right); // focus agents (selects angle-0 = key k0)
    stdin.write("x");
    expect(actions).toEqual([{ type: "stop", target: { scope: "agent", key: "k0" } }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/App.test.tsx`
Expected: FAIL — cannot find `./App.js`.

- [ ] **Step 3: Create `packages/ui/src/App.tsx`**

```tsx
import { Box, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { reduce, initialRunState } from "@workflow/core";
import type { RunState, WorkflowEvent } from "@workflow/core";
import { Header } from "./Header.js";
import { PhasesColumn } from "./PhasesColumn.js";
import { AgentsColumn } from "./AgentsColumn.js";
import { DetailPane } from "./DetailPane.js";
import { orderedPhases, agentsInPhase, detailLines, elapsedMs } from "./selectors.js";
import { navReducer, initialNav, type NavState, type NavCtx } from "./navigation.js";

export type UiAction =
  | { readonly type: "pause" }
  | { readonly type: "stop"; readonly target: { readonly scope: "run" } | { readonly scope: "agent"; readonly key: string } }
  | { readonly type: "restart"; readonly key: string }
  | { readonly type: "save" };

export interface AppProps {
  readonly events: readonly WorkflowEvent[];
  readonly adapter?: string | undefined;
  readonly detailRows?: number;
  readonly onAction?: ((action: UiAction) => void) | undefined;
  readonly animate?: boolean;
}

export function App({ events, adapter, detailRows = 12, onAction, animate = true }: AppProps) {
  const state: RunState = useMemo(() => events.reduce(reduce, initialRunState()), [events]);

  const [nav, setNav] = useState<NavState>(initialNav);
  const [frame, setFrame] = useState(0);

  const phases = useMemo(() => orderedPhases(state), [state]);
  const selectedPhase = phases[Math.min(nav.phaseIndex, Math.max(0, phases.length - 1))];
  const agents = useMemo(
    () => (selectedPhase ? agentsInPhase(state, selectedPhase.title) : []),
    [state, selectedPhase],
  );
  const selectedAgent = agents[Math.min(nav.agentIndex, Math.max(0, agents.length - 1))];
  const detailTotal = selectedAgent ? detailLines(selectedAgent).length : 1;

  // Latest values for the input handler, kept in refs to avoid stale closures.
  const ctxRef = useRef<NavCtx>({ phaseCount: 0, agentCount: 0, maxScroll: 0 });
  ctxRef.current = {
    phaseCount: phases.length,
    agentCount: agents.length,
    maxScroll: Math.max(0, detailTotal - detailRows),
  };
  const navRef = useRef(nav);
  navRef.current = nav;
  const selectedAgentKeyRef = useRef<string | undefined>(undefined);
  selectedAgentKeyRef.current = selectedAgent?.key;

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(id);
  }, [animate]);

  useInput((input, key) => {
    if (key.upArrow) setNav((p) => navReducer(p, { type: "up" }, ctxRef.current));
    else if (key.downArrow) setNav((p) => navReducer(p, { type: "down" }, ctxRef.current));
    else if (key.rightArrow) setNav((p) => navReducer(p, { type: "right" }, ctxRef.current));
    else if (key.leftArrow) setNav((p) => navReducer(p, { type: "left" }, ctxRef.current));
    else if (key.escape) setNav((p) => navReducer(p, { type: "esc" }, ctxRef.current));
    else if (input === "j") setNav((p) => navReducer(p, { type: "scrollDown" }, ctxRef.current));
    else if (input === "k") setNav((p) => navReducer(p, { type: "scrollUp" }, ctxRef.current));
    else if (input === "p") onAction?.({ type: "pause" });
    else if (input === "x") {
      const agentKey = selectedAgentKeyRef.current;
      if (navRef.current.focus !== "phases" && agentKey) onAction?.({ type: "stop", target: { scope: "agent", key: agentKey } });
      else onAction?.({ type: "stop", target: { scope: "run" } });
    } else if (input === "r") {
      const agentKey = selectedAgentKeyRef.current;
      if (agentKey) onAction?.({ type: "restart", key: agentKey });
    } else if (input === "s") onAction?.({ type: "save" });
  });

  return (
    <Box flexDirection="column">
      <Header state={state} elapsedMs={elapsedMs(events)} adapter={adapter} />
      <Box>
        <PhasesColumn phases={phases} selectedIndex={nav.phaseIndex} focused={nav.focus === "phases"} frame={frame} />
        <AgentsColumn
          agents={agents}
          selectedIndex={nav.agentIndex}
          focused={nav.focus === "agents"}
          phaseTitle={selectedPhase?.title ?? ""}
          frame={frame}
        />
        <DetailPane agent={selectedAgent} scroll={nav.scroll} rows={detailRows} focused={nav.focus === "detail"} />
      </Box>
    </Box>
  );
}
```

> Implementation note: `useInput`'s callback can capture stale state across renders,
> so the `x`/`r` branches read `navRef`/`selectedAgentKeyRef` (updated every render),
> and the nav branches use functional `setNav` updates plus `ctxRef` for clamping
> bounds. This is why counts live in refs rather than being read directly.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/App.test.tsx`
Expected: PASS (all four cases — render, focus traversal, action emission, agent-scoped stop).

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/App.tsx packages/ui/src/App.test.tsx
git commit -m "feat(ui): App composing Miller columns + full keybinding parity"
```

---

## Phase 4 — Entry, fallback wiring, public API

### Task 14: `startUi` entry (TTY → Ink, non-TTY → line-log) + public API + full gate

**Files:**
- Create: `packages/ui/src/render.ts`
- Test: `packages/ui/src/render.test.ts`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/src/index.test.ts`

- [ ] **Step 1: Write the failing test `packages/ui/src/render.test.ts`** (non-TTY path is the unit-testable one)

```ts
import { describe, it, expect } from "vitest";
import type { WorkflowEvent } from "@workflow/core";
import { startUi } from "./render.js";

describe("startUi (non-TTY line-log)", () => {
  it("writes a line per meaningful event from initial + subscribed events", () => {
    const written: string[] = [];
    let listener: ((e: WorkflowEvent) => void) | undefined;

    const handle = startUi({
      isTTY: false,
      write: (t) => written.push(t),
      initial: [{ type: "run-started", runId: "r1", name: "demo", at: 0 }],
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    });

    listener?.({ type: "phase-started", phase: "Search", at: 1 });
    listener?.({ type: "agent-queued", key: "k0", label: "a", phase: "Search", at: 2 }); // noisy → no line
    listener?.({ type: "run-finished", runId: "r1", at: 3 });

    expect(written).toEqual(["▶ demo (r1)\n", "# Search\n", "■ done\n"]);

    handle.unmount();
    listener?.({ type: "log", message: "after unmount", at: 4 }); // unsubscribed → ignored
    expect(written).toEqual(["▶ demo (r1)\n", "# Search\n", "■ done\n"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/render.test.ts`
Expected: FAIL — cannot find `./render.js`.

- [ ] **Step 3: Create `packages/ui/src/render.ts`**

```ts
import { render } from "ink";
import { createElement } from "react";
import type { WorkflowEvent } from "@workflow/core";
import { App, type UiAction } from "./App.js";
import { lineLogLine } from "./line-log.js";
import { throttle } from "./throttle.js";

export interface StartUiOptions {
  readonly subscribe: (listener: (event: WorkflowEvent) => void) => () => void;
  readonly initial?: readonly WorkflowEvent[];
  readonly adapter?: string | undefined;
  readonly onAction?: ((action: UiAction) => void) | undefined;
  readonly isTTY?: boolean;
  readonly write?: (text: string) => void;
}

export interface UiHandle {
  unmount(): void;
}

export function startUi(opts: StartUiOptions): UiHandle {
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const initial = opts.initial ?? [];

  if (!isTTY) {
    const write = opts.write ?? ((t: string) => void process.stdout.write(t));
    const emitLine = (e: WorkflowEvent): void => {
      const line = lineLogLine(e);
      if (line !== null) write(line + "\n");
    };
    for (const e of initial) emitLine(e);
    const unsub = opts.subscribe(emitLine);
    return { unmount: unsub };
  }

  let events: WorkflowEvent[] = [...initial];
  const instance = render(createElement(App, { events, adapter: opts.adapter, onAction: opts.onAction }));
  const rerenderNow = (): void => {
    instance.rerender(createElement(App, { events: [...events], adapter: opts.adapter, onAction: opts.onAction }));
  };
  const throttled = throttle(rerenderNow, 100, {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const unsub = opts.subscribe((e) => {
    events = [...events, e];
    throttled.call();
  });
  return {
    unmount: () => {
      throttled.cancel();
      unsub();
      instance.unmount();
    },
  };
}
```

> Note: `Date.now()`/`setTimeout` here are the UI **edge**, outside the `node:vm`
> sandbox, so the determinism ban (which applies only inside the sandbox) does not
> apply. The non-TTY branch is fully deterministic and unit-tested; the Ink/TTY
> branch is exercised by the App tests plus the CLI/e2e suite in Plan 4.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/ui/src/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the public-API test `packages/ui/src/index.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import * as ui from "./index.js";

describe("public API", () => {
  it("exports the entry point, the App, and the pure helpers", () => {
    expect(typeof ui.startUi).toBe("function");
    expect(typeof ui.App).toBe("function");
    expect(typeof ui.lineLogLine).toBe("function");
    expect(typeof ui.formatTokens).toBe("function");
    expect(typeof ui.navReducer).toBe("function");
    expect(typeof ui.orderedPhases).toBe("function");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run packages/ui/src/index.test.ts`
Expected: FAIL — exports undefined (placeholder `index.ts`).

- [ ] **Step 7: Replace `packages/ui/src/index.ts`**

```ts
export { startUi, type StartUiOptions, type UiHandle } from "./render.js";
export { App, type AppProps, type UiAction } from "./App.js";
export { Header, type HeaderProps } from "./Header.js";
export { PhasesColumn, type PhasesColumnProps } from "./PhasesColumn.js";
export { AgentsColumn, type AgentsColumnProps } from "./AgentsColumn.js";
export { DetailPane, type DetailPaneProps } from "./DetailPane.js";
export { Spinner, type SpinnerProps } from "./Spinner.js";
export { lineLogLine } from "./line-log.js";
export { formatTokens, formatElapsed, statusGlyph, SPINNER_FRAMES } from "./format.js";
export { orderedPhases, agentsInPhase, detailLines, elapsedMs } from "./selectors.js";
export {
  navReducer,
  initialNav,
  type NavState,
  type NavAction,
  type NavCtx,
  type FocusColumn,
} from "./navigation.js";
export { throttle, type Throttled, type ThrottleDeps } from "./throttle.js";
```

- [ ] **Step 8: Run the index test**

Run: `pnpm vitest run packages/ui/src/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full gate across the monorepo**

Run: `pnpm test`
Expected: all unit/integration tests across `schema`, `core`, `adapters`, and `ui` PASS (including the Phase 0 core changes and every new UI suite).

Run: `pnpm -r build`
Expected: `@workflow/ui` builds to `dist/` with `index.d.ts`; `react`/`ink` stay external (not bundled); all four packages build clean.

Run: `pnpm -r typecheck`
Expected: no type errors (verbatim/exactOptional/noUncheckedIndexedAccess all satisfied).

Run: `pnpm lint`
Expected: 0 errors. (If oxlint flags anything in `.tsx`, fix inline — common ones: prefer `const`, no unused imports.)

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/render.ts packages/ui/src/render.test.ts packages/ui/src/index.ts packages/ui/src/index.test.ts
git commit -m "feat(ui): startUi entry (TTY/ink + non-TTY line-log) + public API"
```

---

## Self-Review (completed against the spec §8)

**Spec coverage (Plan 3 / §8 portion):**
- Miller-columns / master-detail, persistent side-by-side panes → `App` (Header + `PhasesColumn` + `AgentsColumn` + `DetailPane`), Task 13.
- Left phases column, always visible, live counts + spinner; `↑`/`↓` selects → `PhasesColumn` (Task 10) + `navReducer` (Task 6).
- Middle agents column updates with phase selection; `→` focuses, `↑`/`↓` selects → `AgentsColumn` (Task 11) + nav (Task 6) + `App` wiring (Task 13).
- Right detail pane: prompt, tool calls, streaming result, real-time; `j`/`k` scroll on overflow → `DetailPane` (Task 12), `detailLines` selector (Task 5), and the Phase 0 `prompt`/`resultText`/`agent-output` model (Tasks 1–2).
- `←`/`→` move focus; `Esc` back to phases → nav (Task 6) + `App` (Task 13).
- Keybindings full parity (`↑↓ ←→ esc j/k p x r s`); `x` = stop agent or whole run by focus; `r` = restart selected; `s` = save → `App` `useInput` (Task 13), surfaced as `UiAction` for the CLI to execute in Plan 4.
- Pure function of the event stream; one component tree for run/watch/replay → `App` folds `WorkflowEvent[]` with core `reduce` (Task 13); `startUi` feeds both initial + subscribed events identically (Task 14).
- Throttle re-renders ~10fps + coalesce → `throttle` util (Task 8) applied in `startUi` (Task 14).
- Virtualize long agent lists → windowing in `AgentsColumn` (Task 11).
- Degrade to plain line-log when stdout isn't a TTY → `lineLogLine` (Task 7) + `startUi` non-TTY branch (Task 14).

**Deferred to Plan 4 (correctly out of UI scope):** the CLI commands (`watch`/`run`/`resume`/`stop`/`save`), the event source that tails `events.jsonl` (or in-process subscription) feeding `startUi.subscribe`, executing the emitted `UiAction`s (pause/stop/restart via the runner's `AbortController`; save dialog), and the `s`-key save flow's persistence. The UI only emits intent.

**Placeholder scan:** no TBD/TODO; every code step contains complete, runnable code; every test step has full assertions.

**Type consistency (cross-task):** `RunState`/`AgentState`/`PhaseState`/`WorkflowEvent` come straight from `@workflow/core` (extended in Phase 0 with `agent-queued.prompt`, `agent-output`, `AgentState.prompt`/`resultText`). `NavState`/`NavCtx`/`NavAction` are referenced identically in Tasks 6 and 13. `UiAction` shape (`pause` / `stop` with `target.scope` `run|agent` / `restart` with `key` / `save`) matches between `App` (Task 13) and the App tests. `statusGlyph`/`formatTokens`/`SPINNER_FRAMES` signatures (Task 4) match every call site (`AgentsColumn`, `Header`, `Spinner`). `detailLines` line layout asserted in Task 5 matches the `DetailPane` scroll-window assertions in Task 12. `startUi` options (`subscribe`/`initial`/`isTTY`/`write`/`adapter`/`onAction`) match between Task 14's impl and test.

**Strict-mode review:** optional props that may receive `undefined` are typed `?: T | undefined` (`Header.adapter`, `App.adapter`/`onAction`, `StartUiOptions.adapter`/`onAction`); all computed index accesses guard with `?? fallback` (`SPINNER_FRAMES`, `phases[...]`, `agents[...]`, `events[...]`); no `import React`; type-only imports use `import type`.

---

## Next plan (after Plan 3 is green)

- **Plan 4 — `@workflow/cli`:** `workflow` bin (`run/watch/list/resume/stop/save/adapters`), detached spawning + fs-backed run registry, `events.jsonl` tail → `startUi({ subscribe })`, wiring `UiAction` to the runner's `AbortController` (pause/stop/restart) and the save dialog, consent prompt + permission modes, config files, bundled `deep-research` + `vue-newsletter`, opt-in `pnpm test:e2e`.
```
