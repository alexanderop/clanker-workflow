import { describe, it, expect } from "vitest";
import { reduce, initialRunState, type AgentState, type WorkflowEvent } from "@workflow/core";
import {
  orderedPhases,
  agentsInPhase,
  elapsedMs,
  formatDuration,
  formatModel,
  humanizeTool,
  activityDigest,
  agentElapsedMs,
  runElapsedMs,
  agentRow,
  detailSections,
} from "./selectors.js";

const events: WorkflowEvent[] = [
  { type: "run-started", runId: "r1", name: "demo", at: 100 },
  { type: "phase-started", phase: "Scope", at: 110 },
  { type: "phase-started", phase: "Search", at: 120 },
  { type: "agent-queued", key: "k0", label: "angle-0", phase: "Search", prompt: "find a\nfind b", at: 130 },
  { type: "agent-started", key: "k0", at: 135 },
  { type: "agent-tool", key: "k0", tool: { name: "WebSearch", input: { query: "vue tips" } }, at: 140 },
  { type: "agent-progress", key: "k0", tokens: 1200, model: "claude-opus-4-8[1m]", at: 145 },
  { type: "agent-output", key: "k0", chunk: "result line 1", at: 150 },
  { type: "agent-finished", key: "k0", usage: { inputTokens: 1, outputTokens: 9 }, cached: false, model: "claude-opus-4-8[1m]", at: 160 },
  { type: "run-finished", runId: "r1", at: 170 },
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

  it("elapsedMs is last event at minus first event at", () => {
    expect(elapsedMs(events)).toBe(70);
    expect(elapsedMs([])).toBe(0);
  });
});

describe("formatDuration", () => {
  it("renders sub-minute as Ns and ≥1min as m:ss", () => {
    expect(formatDuration(21_000)).toBe("21s");
    expect(formatDuration(43_400)).toBe("43s");
    expect(formatDuration(83_000)).toBe("1:23");
    expect(formatDuration(600_000)).toBe("10:00");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("formatModel", () => {
  it("maps known ids and a context suffix, falling back to the raw id", () => {
    expect(formatModel("claude-opus-4-8[1m]")).toBe("Opus 4.8 (1M context)");
    expect(formatModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(formatModel("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(formatModel("some-future-model")).toBe("some-future-model");
    expect(formatModel(undefined)).toBe("");
  });
});

describe("humanizeTool", () => {
  it("shows Name(firstArg…) preferring descriptive keys", () => {
    expect(humanizeTool({ name: "WebFetch", input: { url: "https://x", prompt: "List all blog posts" } })).toBe(
      "WebFetch(List all blog posts)",
    );
  });
  it("truncates long args", () => {
    const long = "a".repeat(80);
    expect(humanizeTool({ name: "Bash", input: { command: long } }).endsWith("…)")).toBe(true);
  });
  it("special-cases StructuredOutput and arg-less tools", () => {
    expect(humanizeTool({ name: "StructuredOutput", input: { n: 7 } })).toBe("StructuredOutput");
    expect(humanizeTool({ name: "Think" })).toBe("Think");
    expect(humanizeTool({ name: "Read", input: {} })).toBe("Read");
  });
});

describe("activityDigest", () => {
  it("returns the last k humanized tools plus the total", () => {
    const a: AgentState = {
      key: "k", label: "l", phase: "p", prompt: "", resultText: "", status: "running", tokens: 0,
      tools: [
        { name: "A", input: { query: "1" } },
        { name: "B", input: { query: "2" } },
        { name: "C", input: { query: "3" } },
        { name: "D", input: { query: "4" } },
      ],
    };
    const digest = activityDigest(a, 3);
    expect(digest.total).toBe(4);
    expect(digest.shown).toEqual(["B(2)", "C(3)", "D(4)"]);
  });
});

describe("elapsed helpers", () => {
  it("freezes agent elapsed at endedAt once done", () => {
    expect(agentElapsedMs(agent, 9_999_999)).toBe(160 - 135);
  });
  it("uses now while an agent is still running", () => {
    const running: AgentState = {
      key: "r", label: "l", phase: "p", prompt: "", resultText: "", status: "running", tokens: 0, tools: [], startedAt: 135,
    };
    expect(agentElapsedMs(running, 200)).toBe(65);
  });
  it("runElapsedMs freezes at run endedAt", () => {
    expect(runElapsedMs(state, 9_999_999)).toBe(170 - 100);
  });
});

describe("agentRow", () => {
  it("summarizes a finished agent's row datum", () => {
    const row = agentRow(agent, 9_999_999);
    expect(row.status).toBe("done");
    expect(row.label).toBe("angle-0");
    expect(row.model).toBe("Opus 4.8 (1M context)");
    expect(row.toolCount).toBe(1);
    expect(row.elapsed).toBe("0s"); // events are 25ms apart in this fixture
    expect(row.tokens).toBe("10"); // input+output = 10 once done
  });
});

describe("detailSections", () => {
  it("lays out Status / Metrics / Prompt / Activity / Outcome with a collapsed prompt", () => {
    const longPrompt: AgentState = { ...agent, prompt: "line1\nline2\nline3\nline4" };
    const lines = detailSections(longPrompt, 9_999_999, false);
    expect(lines[0]).toBe("✓ Completed · Opus 4.8 (1M context)");
    expect(lines[1]).toBe("10 tok · 1 tool call · 0s");
    expect(lines).toContain("Prompt · 4 lines · ⏎ expand");
    expect(lines).toContain("  … 2 more lines");
    expect(lines.some((l) => l.startsWith("Activity"))).toBe(true);
    expect(lines).toContain("  WebSearch(vue tips)");
    expect(lines).toContain("Outcome");
    expect(lines).toContain("  result line 1");
  });

  it("expands the full prompt when expanded", () => {
    const longPrompt: AgentState = { ...agent, prompt: "line1\nline2\nline3\nline4" };
    const lines = detailSections(longPrompt, 9_999_999, true);
    expect(lines).toContain("Prompt · 4 lines · ⏎ collapse");
    expect(lines).toContain("  line4");
    expect(lines).not.toContain("  … 2 more lines");
  });
});
