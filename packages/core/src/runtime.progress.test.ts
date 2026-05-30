import { describe, it, expect } from "vitest";
import { ok } from "neverthrow";
import { createRuntime } from "./runtime.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";
import type { WorkflowEvent } from "./events.js";
import type { AgentProgress, AgentRunner } from "./types.js";

/** A runner that replays a scripted sequence of progress signals before resolving. */
function progressRunner(signals: readonly AgentProgress[]): AgentRunner {
  return {
    id: "prog",
    capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: true },
    run: async (_req, ctx) => {
      for (const s of signals) ctx.onProgress?.(s);
      return ok({ text: "done", usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] });
    },
  };
}

function harness(runner: AgentRunner, clockSteps: () => number) {
  const events: WorkflowEvent[] = [];
  const rt = createRuntime({
    runner,
    semaphore: createSemaphore(8),
    journal: createJournal(),
    maxAgents: 1000,
    budgetTotal: null,
    args: {},
    cwd: "/tmp",
    runId: "r1",
    emit: (e) => events.push(e),
    now: clockSteps,
  });
  return { rt, events };
}

describe("runtime onProgress wiring", () => {
  it("forwards each tool call as an agent-tool event immediately", async () => {
    const runner = progressRunner([
      { tool: { name: "WebFetch", input: { url: "a" } } },
      { tool: { name: "WebFetch", input: { url: "b" } } },
    ]);
    let clock = 0;
    const { rt, events } = harness(runner, () => clock++);
    await rt.agent("do it", { label: "a" });
    const tools = events.filter((e) => e.type === "agent-tool");
    expect(tools.map((e) => (e.type === "agent-tool" ? e.tool.name : ""))).toEqual(["WebFetch", "WebFetch"]);
  });

  it("coalesces token/model progress to <=1 per second and clamps tokens monotonic", async () => {
    const runner = progressRunner([
      { tokens: 10, model: "claude-opus-4-8[1m]" }, // at=0 → emitted (first)
      { tokens: 20 }, // at=1 (<1000ms) → dropped
      { tokens: 5 }, // at=2 → dropped (and clamped to 20)
      { tokens: 30 }, // at=3 → dropped
    ]);
    // Clock jumps by 1ms per call except where we force a gap below.
    let clock = 0;
    const { rt, events } = harness(runner, () => clock++);
    await rt.agent("do it", { label: "a" });
    const progress = events.filter((e) => e.type === "agent-progress");
    // Only the first token update is persisted (rest within the 1s window).
    expect(progress).toHaveLength(1);
    const p = progress[0]!;
    if (p.type === "agent-progress") {
      expect(p.tokens).toBe(10);
      expect(p.model).toBe("claude-opus-4-8[1m]");
    }
  });

  it("emits a second progress once the 1s window elapses, with the clamped max so far", async () => {
    const runner = progressRunner([
      { tokens: 10 }, // at=0 → emitted
      { tokens: 5 }, // at=2000 → emitted, clamped up to 10
    ]);
    const stamps = [0, 0, 0, 2000, 2000, 2000];
    let i = 0;
    const { rt, events } = harness(runner, () => stamps[Math.min(i++, stamps.length - 1)]!);
    await rt.agent("do it", { label: "a" });
    const tokens = events.filter((e) => e.type === "agent-progress").map((e) => (e.type === "agent-progress" ? e.tokens : -1));
    expect(tokens).toEqual([10, 10]);
  });

  it("carries the streamed model onto agent-finished", async () => {
    const runner = progressRunner([{ model: "gpt-5-codex", tokens: 1 }]);
    let clock = 0;
    const { rt, events } = harness(runner, () => clock++);
    await rt.agent("do it", { label: "a" });
    const finished = events.find((e) => e.type === "agent-finished");
    expect(finished?.type === "agent-finished" ? finished.model : undefined).toBe("gpt-5-codex");
  });

  it("derives an unlabeled agent's label from the prompt's first non-empty line", async () => {
    const runner = progressRunner([]);
    let clock = 0;
    const { rt, events } = harness(runner, () => clock++);
    await rt.agent("\n  Use the WebFetch tool to find posts\nmore detail here");
    const queued = events.find((e) => e.type === "agent-queued");
    expect(queued?.type === "agent-queued" ? queued.label : "").toBe("Use the WebFetch tool to find posts");
  });

  it("truncates a long derived label with an ellipsis", async () => {
    const runner = progressRunner([]);
    let clock = 0;
    const { rt, events } = harness(runner, () => clock++);
    const long = "This is an extremely long first line that should be truncated for display in the agents column";
    await rt.agent(long);
    const queued = events.find((e) => e.type === "agent-queued");
    const label = queued?.type === "agent-queued" ? queued.label : "";
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.endsWith("…")).toBe(true);
  });
});
