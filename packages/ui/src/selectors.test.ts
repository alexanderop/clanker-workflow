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
