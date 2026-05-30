import { describe, it, expect } from "vitest";
import { reduce, initialRunState, type WorkflowEvent, type AgentState } from "@workflow/core";
import { event, usage } from "@workflow/test-support";
import {
  orderedPhases,
  agentsInPhase,
  runElapsedMs,
  agentElapsedMs,
  humanizeTool,
  activityDigest,
  promptPreview,
  agentRow,
  detailSections,
  elapsedMs,
} from "./selectors.js";

// All agent events share the factory's default key, so they link into one agent — only the
// fields each assertion cares about (timeline `at`, label/phase, tokens, tool, chunk) are spelled out.
const MODEL = "claude-opus-4-8[1m]";
const events: WorkflowEvent[] = [
  event("run-started", { runId: "r1", name: "demo", at: 100 }),
  event("phase-started", { phase: "Scope", at: 110 }),
  event("phase-started", { phase: "Search", at: 120 }),
  event("agent-queued", { label: "angle-0", phase: "Search", prompt: "find a\nfind b", at: 130 }),
  event("agent-started", { at: 135 }),
  event("agent-progress", { tokens: 20400, model: MODEL, at: 138 }),
  event("agent-tool", { tool: { name: "WebFetch", input: { url: "https://alexop.dev/list-everything" } }, at: 140 }),
  event("agent-output", { chunk: "result line 1", at: 150 }),
  event("agent-finished", { usage: usage({ inputTokens: 1, outputTokens: 9 }), model: MODEL, at: 160 }),
];
const state = events.reduce(reduce, initialRunState());
const agent = agentsInPhase(state, "Search")[0]!;

describe("selectors", () => {
  it("orderedPhases preserves insertion order", () => {
    expect(orderedPhases(state).map((p) => p.title)).toEqual(["Scope", "Search"]);
  });

  it("agentsInPhase returns only that phase's agents", () => {
    expect(agentsInPhase(state, "Search").map((a) => a.label)).toEqual(["angle-0"]);
    expect(agentsInPhase(state, "Scope")).toEqual([]);
  });

  it("runElapsedMs / agentElapsedMs use injected now (live) and freeze when ended", () => {
    expect(runElapsedMs(state, 200)).toBe(100); // running: now - startedAt
    expect(agentElapsedMs(agent, 9999)).toBe(160 - 135); // frozen at endedAt
    expect(runElapsedMs(initialRunState(), 5)).toBe(0);
  });

  it("runElapsedMs freezes at run-finished for a finished/watched run, ignoring live now", () => {
    const finished = [
      event("run-started", { runId: "r", name: "d", at: 1000 }),
      event("run-finished", { runId: "r", at: 4000 }),
    ].reduce(reduce, initialRunState());
    expect(runElapsedMs(finished, 9_999_999)).toBe(3000); // not now - startedAt
  });

  it("humanizeTool previews the first arg, special-cases StructuredOutput and arg-less tools", () => {
    expect(humanizeTool({ name: "WebFetch", input: { url: "https://alexop.dev/x" } })).toBe("WebFetch(https://alexop.dev/x)");
    expect(humanizeTool({ name: "StructuredOutput", input: { n: 7 } })).toBe("StructuredOutput");
    expect(humanizeTool({ name: "Done" })).toBe("Done");
    const long = "a".repeat(80);
    expect(humanizeTool({ name: "T", input: long })).toBe(`T(${"a".repeat(38)}…)`);
  });

  it("activityDigest returns the last k humanized tools and the total", () => {
    const tools = Array.from({ length: 6 }, (_, i) => ({ name: `T${i}` }));
    const a: AgentState = { ...agent, tools };
    const d = activityDigest(a, 3);
    expect(d.total).toBe(6);
    expect(d.shown).toEqual(["T3", "T4", "T5"]);
  });

  it("promptPreview shows head + remaining count, or all lines when expanded", () => {
    const prompt = "l1\nl2\nl3\nl4";
    expect(promptPreview(prompt, false, 2)).toEqual(["l1", "l2", "… 2 more lines"]);
    expect(promptPreview(prompt, true, 2)).toEqual(["l1", "l2", "l3", "l4"]);
    expect(promptPreview("only", false, 2)).toEqual(["only"]);
  });

  it("agentRow exposes model/tokens/toolCount/elapsed for a finished agent", () => {
    const row = agentRow(agent, 9999);
    expect(row.status).toBe("done");
    expect(row.model).toBe("Opus 4.8 (1M context)");
    expect(row.tokens).toBe("10"); // final inputTokens+outputTokens = 1+9
    expect(row.toolCount).toBe(1);
    expect(row.elapsed).toBe("0s");
  });

  it("agentRow shows live tokens while running", () => {
    const running: AgentState = {
      key: "k1", label: "live", phase: "Search", prompt: "", resultText: "",
      status: "running", tokens: 0, inputTokens: 0, outputTokens: 0, cached: false, tools: [], startedAt: 135, liveTokens: 20400,
    };
    expect(agentRow(running, 135 + 21000).tokens).toBe("20.4k");
    expect(agentRow(running, 135 + 21000).elapsed).toBe("21s");
  });

  it("detailSections lays out Status / Metrics / Prompt / Activity / Outcome", () => {
    const lines = detailSections(agent, 9999, false);
    expect(lines[0]).toBe("Completed · Opus 4.8 (1M context)");
    expect(lines.some((l) => l.startsWith("Prompt · 2 lines"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Activity · last 1 of 1 tool calls"))).toBe(true);
    expect(lines).toContain("Outcome");
    expect(lines).toContain("  result line 1");
  });

  it("detailSections shows an Error section with the failure reason for a failed agent", () => {
    const failed: AgentState = {
      ...agent,
      status: "failed",
      error: { kind: "AdapterSpawn", adapter: "claude", cause: "exit 1: rate limited" },
    };
    const lines = detailSections(failed, 9999, false);
    expect(lines[0]).toBe("Failed · Opus 4.8 (1M context)");
    expect(lines).toContain("Error");
    expect(lines).toContain("  AdapterSpawn (claude): exit 1: rate limited");
  });

  it("elapsedMs is last event at minus first event at", () => {
    expect(elapsedMs(events)).toBe(60);
    expect(elapsedMs([])).toBe(0);
  });
});
