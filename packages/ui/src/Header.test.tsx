import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { reduce, initialRunState, type WorkflowEvent } from "@workflow/core";
import { Header } from "./Header.js";

const state = ([
  { type: "run-started", runId: "r1", name: "deep-research", description: "Find the best Vue tips", at: 0 },
  { type: "agent-queued", key: "k", label: "a", phase: "Search", at: 1 },
  { type: "agent-finished", key: "k", usage: { inputTokens: 0, outputTokens: 318000 }, cached: false, at: 2 },
] satisfies WorkflowEvent[]).reduce(reduce, initialRunState());

describe("Header", () => {
  it("shows name, agent counts, run elapsed, status, description and adapter", () => {
    const { lastFrame } = render(<Header state={state} elapsedMs={161000} adapter="codex" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deep-research");
    expect(frame).toContain("Find the best Vue tips");
    expect(frame).toContain("running");
    expect(frame).toContain("1/1 agent");
    expect(frame).toContain("2:41");
    expect(frame).toContain("codex");
  });

  it("omits the adapter segment when none is given", () => {
    const { lastFrame } = render(<Header state={state} elapsedMs={0} />);
    expect(lastFrame() ?? "").not.toContain("codex");
  });
});
