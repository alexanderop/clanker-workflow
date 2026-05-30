import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { AgentState } from "@workflow/core";
import { DetailPane } from "./DetailPane.js";

const agent: AgentState = {
  key: "k0",
  label: "angle-0",
  phase: "Search",
  prompt: "line P",
  resultText: "R1\nR2\nR3\nR4",
  status: "running",
  tokens: 44000,
  tools: [{ name: "WebSearch", input: { query: "vue" } }],
};

describe("DetailPane", () => {
  it("renders Status / Metrics / Prompt / Activity / Outcome sections", () => {
    const { lastFrame } = render(<DetailPane agent={agent} scroll={0} rows={20} focused now={0} expanded={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Running");
    expect(frame).toContain("44k tok · 1 tool call");
    expect(frame).toContain("Prompt");
    expect(frame).toContain("line P");
    expect(frame).toContain("Activity");
    expect(frame).toContain("WebSearch(vue)");
    expect(frame).toContain("Outcome");
    expect(frame).toContain("R1");
  });

  it("scrolls: a positive scroll offset hides leading lines", () => {
    const { lastFrame } = render(<DetailPane agent={agent} scroll={11} rows={3} focused now={0} expanded={false} />);
    const frame = lastFrame() ?? "";
    // Outcome result lines are R1..R4 at the tail; scrolling near the end shows R2+.
    expect(frame).toContain("R2");
    expect(frame).not.toContain("Running");
    expect(frame).not.toContain("R1\n");
  });

  it("truncates long lines so the pane never grows past its row budget", () => {
    const longAgent: AgentState = { ...agent, prompt: "x".repeat(400), resultText: "y".repeat(400), tools: [] };
    const rows = 4;
    const { lastFrame } = render(<DetailPane agent={longAgent} scroll={0} rows={rows} focused now={0} expanded={false} />);
    const rowCount = (lastFrame() ?? "").split("\n").length;
    // rows of content + top/bottom border + a scroll-indicator line — long lines stay one row each.
    expect(rowCount).toBeLessThanOrEqual(rows + 3);
  });

  it("shows a placeholder when no agent is selected", () => {
    const { lastFrame } = render(<DetailPane agent={undefined} scroll={0} rows={5} focused={false} now={0} expanded={false} />);
    expect(lastFrame() ?? "").toContain("no agent selected");
  });
});
