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
