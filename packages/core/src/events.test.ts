import { describe, it, expect } from "vitest";
import { reduce, initialRunState, type WorkflowEvent } from "./events.js";

describe("event reducer", () => {
  it("accumulates phase counts and tokens from an event stream", () => {
    const events: WorkflowEvent[] = [
      { type: "run-started", runId: "r1", name: "demo", at: 0 },
      { type: "phase-started", phase: "Search", at: 1 },
      { type: "agent-queued", key: "0", label: "a", phase: "Search", at: 2 },
      { type: "agent-started", key: "0", at: 3 },
      { type: "agent-finished", key: "0", usage: { inputTokens: 5, outputTokens: 10 }, cached: false, at: 4 },
    ];
    const state = events.reduce(reduce, initialRunState());
    const phase = state.phases.get("Search")!;
    expect(phase.total).toBe(1);
    expect(phase.done).toBe(1);
    expect(state.totalTokens).toBe(15);
  });

  it("is pure — does not mutate the input state", () => {
    const s0 = initialRunState();
    reduce(s0, { type: "phase-started", phase: "X", at: 0 });
    expect(s0.phases.size).toBe(0);
  });

  it("stores the prompt from agent-queued on the agent state", () => {
    const events: WorkflowEvent[] = [
      { type: "agent-queued", key: "0", label: "a", phase: "Search", prompt: "Search the web for X", at: 0 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.agents.get("0")?.prompt).toBe("Search the web for X");
  });

  it("accumulates agent-output chunks into resultText", () => {
    const events: WorkflowEvent[] = [
      { type: "agent-queued", key: "0", label: "a", phase: "P", at: 0 },
      { type: "agent-output", key: "0", chunk: "hello ", at: 1 },
      { type: "agent-output", key: "0", chunk: "world", at: 2 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.agents.get("0")?.resultText).toBe("hello world");
  });
});
