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

  it("tracks liveness: run/agent timestamps, live tokens, model, and appended tools", () => {
    const events: WorkflowEvent[] = [
      { type: "run-started", runId: "r1", name: "demo", at: 100 },
      { type: "agent-queued", key: "0", label: "a", phase: "P", at: 110 },
      { type: "agent-started", key: "0", at: 120 },
      { type: "agent-tool", key: "0", tool: { name: "WebFetch" }, at: 130 },
      { type: "agent-progress", key: "0", tokens: 50, model: "claude-opus-4-8[1m]", at: 140 },
      { type: "agent-progress", key: "0", tokens: 200, at: 150 },
      { type: "agent-finished", key: "0", usage: { inputTokens: 10, outputTokens: 300 }, cached: false, model: "claude-opus-4-8[1m]", at: 160 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.startedAt).toBe(100);
    const a = state.agents.get("0")!;
    expect(a.startedAt).toBe(120);
    expect(a.endedAt).toBe(160);
    expect(a.liveTokens).toBe(200);
    expect(a.model).toBe("claude-opus-4-8[1m]");
    expect(a.tokens).toBe(310);
    expect(a.tools.map((t) => t.name)).toEqual(["WebFetch"]);
  });

  it("keeps the original startedAt across a restart (re-emitted agent-started)", () => {
    const events: WorkflowEvent[] = [
      { type: "agent-queued", key: "0", label: "a", phase: "P", at: 0 },
      { type: "agent-started", key: "0", at: 10 },
      { type: "agent-started", key: "0", at: 99 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.agents.get("0")?.startedAt).toBe(10);
  });

  it("agent-failed records endedAt", () => {
    const events: WorkflowEvent[] = [
      { type: "agent-queued", key: "0", label: "a", phase: "P", at: 0 },
      { type: "agent-started", key: "0", at: 10 },
      { type: "agent-failed", key: "0", error: { kind: "AgentCapExceeded", cap: 1 }, at: 20 },
    ];
    const state = events.reduce(reduce, initialRunState());
    expect(state.agents.get("0")?.endedAt).toBe(20);
  });
});
