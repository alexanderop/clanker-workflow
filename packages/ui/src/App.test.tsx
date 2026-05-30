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
// Let ink's useInput effect attach its stdin listener, and let state-driven
// re-renders (which refresh the input handler's refs) commit between keypresses.
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("App", () => {
  it("renders the header and all three columns from the event stream", () => {
    const { lastFrame } = render(<App events={events} adapter="codex" animate={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deep-research");
    expect(frame).toContain("PHASES");
    expect(frame).toContain("Scope 0/0");
    expect(frame).toContain("Search 1/1");
    // Footer key hints are present at the list level.
    expect(frame).toContain("select");
  });

  it("right-arrow focuses agents so the selected phase's agents show, then detail", async () => {
    const { lastFrame, stdin } = render(<App events={events} animate={false} />);
    await tick();
    stdin.write(KEY.down); // select phase index 1 (Search)
    await tick();
    stdin.write(KEY.right); // focus agents
    await tick();
    expect(lastFrame() ?? "").toContain("Search");
    expect(lastFrame() ?? "").toContain("angle-0");
    stdin.write(KEY.right); // focus detail
    await tick();
    expect(lastFrame() ?? "").toContain("found stuff");
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
});
