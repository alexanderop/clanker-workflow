import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { AgentState } from "@workflow/core";
import { AgentsColumn } from "./AgentsColumn.js";

function agent(label: string, status: AgentState["status"], tokens = 0, extra: Partial<AgentState> = {}): AgentState {
  return { key: label, label, phase: "Search", prompt: "", resultText: "", status, tokens, tools: [], ...extra };
}

describe("AgentsColumn", () => {
  it("shows the phase title and per-agent glyph, model and live metrics", () => {
    const agents = [
      agent("angle-0", "done", 18000, { model: "claude-opus-4-8[1m]", startedAt: 0, endedAt: 18000, tools: [{ name: "WebFetch" }] }),
      agent("angle-1", "running", 0, { startedAt: 0 }),
    ];
    const { lastFrame } = render(<AgentsColumn agents={agents} selectedIndex={0} focused phaseTitle="Search" frame={0} now={18000} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Search");
    expect(frame).toContain("angle-0");
    expect(frame).toContain("18k tok");
    expect(frame).toContain("Opus 4.8");
    expect(frame).toContain("angle-1");
  });

  it("shows a not-started hint when the selected phase has no agents yet", () => {
    const { lastFrame } = render(<AgentsColumn agents={[]} selectedIndex={0} focused phaseTitle="Curate" frame={0} now={0} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Curate");
    expect(frame).toContain("not started yet");
  });

  it("virtualizes: renders at most maxVisible rows, windowed around the selection", () => {
    const agents = Array.from({ length: 100 }, (_, i) => agent(`a${i}`, "queued"));
    const { lastFrame } = render(
      <AgentsColumn agents={agents} selectedIndex={50} focused phaseTitle="Search" frame={0} now={0} maxVisible={5} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a50"); // selection visible
    expect(frame).not.toContain("a0 "); // far-away rows not rendered
    expect(frame).not.toContain("a99");
    const rendered = ["a48", "a49", "a50", "a51", "a52"].filter((l) => frame.includes(l));
    expect(rendered.length).toBe(5);
  });
});
