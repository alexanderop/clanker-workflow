import { describe, it, expect, vi, afterEach } from "vitest";
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
// Let ink's useInput effect attach its stdin listener, and let state-driven
// re-renders (which refresh the input handler's refs) commit between keypresses.
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("App", () => {
  it("renders the header and all three columns from the event stream", () => {
    const { lastFrame } = render(<App events={events} adapter="codex" animate={false} now={10} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deep-research");
    expect(frame).toContain("Phases");
    expect(frame).toContain("Scope 0/0");
    expect(frame).toContain("Search 1/1");
    expect(frame).toContain("1/1 agent"); // header agent counts
    expect(frame).toContain("Scope · 0 agents"); // agents column header for the selected phase
    expect(frame).not.toContain("╭");
    expect(frame).not.toContain("╰");
    expect(frame).not.toContain("found stuff"); // overview mode does not render the detail pane
  });

  it("right-arrow focuses agents so the selected phase's agents show, then detail", async () => {
    const { lastFrame, stdin } = render(<App events={events} animate={false} />);
    await tick();
    stdin.write(KEY.down); // select phase index 1 (Search)
    await tick();
    stdin.write(KEY.right); // focus agents
    await tick();
    expect(lastFrame() ?? "").toContain("Search · 1 agent");
    expect(lastFrame() ?? "").toContain("angle-0");
    stdin.write(KEY.right); // focus detail
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Search · 1 agent");
    expect(frame).toContain("angle-0");
    expect(frame).toContain("Completed");
    expect(frame).toContain("found stuff");
    expect(frame).not.toContain("Phases");
  });

  it("emits pause/stop/save actions via onAction", async () => {
    const actions: UiAction[] = [];
    const { stdin } = render(<App events={events} animate={false} onAction={(a) => actions.push(a)} />);
    await tick();
    stdin.write("p");
    await tick();
    stdin.write("x"); // focus is phases → stop whole run
    await tick();
    stdin.write("s");
    await tick();
    expect(actions).toEqual([
      { type: "pause" },
      { type: "stop", target: { scope: "run" } },
      { type: "save" },
    ]);
  });

  it("stop targets the selected agent when focus is on agents/detail", async () => {
    const actions: UiAction[] = [];
    const { stdin } = render(<App events={events} animate={false} onAction={(a) => actions.push(a)} />);
    await tick();
    stdin.write(KEY.down); // Search
    await tick();
    stdin.write(KEY.right); // focus agents (selects angle-0 = key k0)
    await tick();
    stdin.write("x");
    await tick();
    expect(actions).toEqual([{ type: "stop", target: { scope: "agent", key: "k0" } }]);
  });

  it("restart ('r') emits a restart action for the selected agent's key", async () => {
    const actions: UiAction[] = [];
    const { stdin } = render(<App events={events} animate={false} onAction={(a) => actions.push(a)} />);
    await tick();
    stdin.write(KEY.down); // Search
    await tick();
    stdin.write(KEY.right); // focus agents → selects angle-0 (key k0)
    await tick();
    stdin.write("r");
    await tick();
    expect(actions).toEqual([{ type: "restart", key: "k0" }]);
  });

  it("restart ('r') is a no-op when no agent is selected", async () => {
    const actions: UiAction[] = [];
    // Phase "Scope" has no agents, so selectedAgent is undefined and there is no key.
    const { stdin } = render(<App events={events} animate={false} onAction={(a) => actions.push(a)} />);
    await tick();
    stdin.write("r"); // focus is phases, selected phase (Scope) has no agents
    await tick();
    expect(actions).toEqual([]);
  });

  it("scrolls the detail pane with j/k once focused on detail", async () => {
    // A long result so the detail content overflows and is scrollable.
    const longEvents: WorkflowEvent[] = [
      { type: "run-started", runId: "r1", name: "demo", at: 0 },
      { type: "phase-started", phase: "Search", at: 1 },
      { type: "agent-queued", key: "k0", label: "angle-0", phase: "Search", prompt: "Search X", at: 2 },
      { type: "agent-started", key: "k0", at: 3 },
      { type: "agent-output", key: "k0", chunk: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), at: 4 },
      { type: "agent-finished", key: "k0", usage: { inputTokens: 1, outputTokens: 9 }, cached: false, at: 5 },
    ];
    const { lastFrame, stdin } = render(<App events={longEvents} animate={false} detailRows={6} now={10} />);
    await tick();
    stdin.write(KEY.right); // focus agents
    await tick();
    stdin.write(KEY.right); // focus detail
    await tick();
    const before = lastFrame() ?? "";
    expect(before).toMatch(/of \d+ ↓/); // scroll indicator present
    stdin.write("j"); // scroll down
    await tick();
    stdin.write("j");
    await tick();
    const after = lastFrame() ?? "";
    expect(after).not.toBe(before); // window moved
    stdin.write("k"); // scroll back up
    await tick();
    expect(lastFrame() ?? "").not.toBe(after);
  });
});

describe("App live ticker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the live clock via setInterval while the run is running", async () => {
    vi.useFakeTimers();
    // No `now` prop and animate defaulting to true → the ticker effect runs because
    // the run is still running (no run-finished event).
    const runningEvents: WorkflowEvent[] = [
      { type: "run-started", runId: "r1", name: "demo", at: 0 },
      { type: "phase-started", phase: "Search", at: 1 },
      { type: "agent-queued", key: "k0", label: "angle-0", phase: "Search", prompt: "P", at: 2 },
      { type: "agent-started", key: "k0", at: 3 },
    ];
    vi.setSystemTime(1000);
    const { lastFrame, unmount } = render(<App events={runningEvents} adapter="codex" />);
    const initial = lastFrame() ?? "";
    expect(initial).toContain("demo");
    // Advance the wall clock and fire several ticker intervals; `now` and `frame`
    // update, so the rendered elapsed timer moves forward.
    vi.setSystemTime(8000);
    await vi.advanceTimersByTimeAsync(1000);
    const advanced = lastFrame() ?? "";
    expect(advanced).not.toBe(initial); // elapsed clock advanced
    unmount();
  });

  it("does not tick once the run has finished", async () => {
    vi.useFakeTimers();
    const finishedEvents: WorkflowEvent[] = [
      { type: "run-started", runId: "r1", name: "demo", at: 0 },
      { type: "phase-started", phase: "Search", at: 1 },
      { type: "run-finished", runId: "r1", at: 2 },
    ];
    vi.setSystemTime(5000);
    const { lastFrame, unmount } = render(<App events={finishedEvents} />);
    const initial = lastFrame() ?? "";
    vi.setSystemTime(60000);
    await vi.advanceTimersByTimeAsync(2000);
    // The effect early-returns for a finished run, so no setInterval was registered
    // and the frame is unchanged despite the clock jumping forward.
    expect(lastFrame() ?? "").toBe(initial);
    unmount();
  });
});
