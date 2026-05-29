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
