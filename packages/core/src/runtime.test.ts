import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { createScriptedRunner } from "./scripted-runner.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";
import type { WorkflowEvent } from "./events.js";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx } from "./types.js";
import { ok } from "neverthrow";

function harness(responses = {}, opts = {}) {
  const events: WorkflowEvent[] = [];
  let clock = 0;
  const rt = createRuntime({
    runner: createScriptedRunner(responses, opts),
    semaphore: createSemaphore(8),
    journal: createJournal(),
    maxAgents: 1000,
    budgetTotal: null,
    args: { topic: "vue" },
    cwd: "/tmp",
    runId: "r1",
    emit: (e) => events.push(e),
    now: () => clock++,
  });
  return { rt, events };
}

describe("runtime.agent", () => {
  it("returns the text when no schema is given and exposes args", async () => {
    const { rt } = harness({ "agent": { text: "hello" } });
    expect(rt.args).toEqual({ topic: "vue" });
    const out = await rt.agent("say hi", { label: "agent" });
    expect(out).toBe("hello");
  });

  it("returns validated typed data when a schema is given", async () => {
    const { rt } = harness({ "a": { data: { n: 7 } } });
    const out = await rt.agent("give n", { label: "a", schema: z.object({ n: z.number() }) });
    expect(out).toEqual({ n: 7 });
  });

  it("records spend against the budget", async () => {
    const { rt } = harness({ "a": { text: "x", outputTokens: 25 } });
    await rt.agent("p", { label: "a" });
    expect(rt.budget.spent()).toBe(25);
  });

  it("emits queued/started/finished events for an agent", async () => {
    const { rt, events } = harness({ "a": { text: "x" } });
    rt.phase("Search");
    await rt.agent("p", { label: "a" });
    const types = events.map((e) => e.type);
    expect(types).toEqual(["phase-started", "agent-queued", "agent-started", "agent-output", "agent-finished"]);
  });

  it("throws when the runner fails, so parallel can null it", async () => {
    const { rt } = harness({ "a": { fail: { kind: "AdapterSpawn", adapter: "scripted", cause: "boom" } } });
    await expect(rt.agent("p", { label: "a" })).rejects.toThrow();
  });
});

describe("resolveRunner: per-call adapter dispatch", () => {
  it("routes to runnerB when adapter matches, and falls back to default runner for unknown id", async () => {
    const events: WorkflowEvent[] = [];
    const runnerA = createScriptedRunner({ x: { text: "from-a" } });
    const runnerB = createScriptedRunner({ x: { text: "from-b" } });
    const rt = createRuntime({
      runner: runnerA,
      semaphore: createSemaphore(8),
      journal: createJournal(),
      maxAgents: 1000,
      budgetTotal: null,
      args: {},
      cwd: "/tmp",
      runId: "r1",
      emit: (e) => events.push(e),
      now: () => 0,
      resolveRunner: (id) => (id === "b" ? runnerB : undefined),
    });

    // adapter "b" → runnerB
    await rt.agent("p", { label: "x", adapter: "b" });
    expect(runnerB.callCount()).toBe(1);
    expect(runnerA.callCount()).toBe(0);

    // unknown adapter "zzz" → falls back to runnerA
    await rt.agent("p", { label: "x", adapter: "zzz" });
    expect(runnerA.callCount()).toBe(1);
    expect(runnerB.callCount()).toBe(1);
  });
});

describe("runtime stop/pause hooks", () => {
  it("an already-aborted signal rejects agent() without invoking the runner", async () => {
    const events: WorkflowEvent[] = [];
    const runner = createScriptedRunner({ a: { text: "x" } });
    const controller = new AbortController();
    controller.abort();
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
      now: () => 0,
      signal: controller.signal,
    });
    await expect(rt.agent("p", { label: "a" })).rejects.toThrow();
    expect(runner.callCount()).toBe(0);
    expect(events.map((e) => e.type)).toContain("agent-failed");
  });

  it("awaits the gate before starting the agent (pause)", async () => {
    const events: WorkflowEvent[] = [];
    const runner = createScriptedRunner({ a: { text: "x" } });
    let release!: () => void;
    const gatePromise = new Promise<void>((r) => (release = r));
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
      now: () => 0,
      gate: () => gatePromise,
    });
    const pending = rt.agent("p", { label: "a" });
    await Promise.resolve();
    expect(events.map((e) => e.type)).not.toContain("agent-started");
    release();
    await pending;
    expect(events.map((e) => e.type)).toContain("agent-started");
  });
});

describe("makeIsolatedCwd: worktree isolation hook", () => {
  /** A recording runner that captures the cwd from each AgentRequest. */
  function createRecordingRunner(response: AgentResult): AgentRunner & { lastCwd(): string | undefined } {
    let lastCwd: string | undefined;
    return {
      id: "recording",
      capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: false },
      run: async (req: AgentRequest, _ctx: RunCtx) => {
        lastCwd = req.cwd;
        return ok(response);
      },
      lastCwd: () => lastCwd,
    };
  }

  it("passes the isolated cwd to the runner and calls cleanup once", async () => {
    const cleanup = vi.fn(async () => undefined as void);
    const runner = createRecordingRunner({
      text: "ok",
      data: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
    });

    const rt = createRuntime({
      runner,
      semaphore: createSemaphore(8),
      journal: createJournal(),
      maxAgents: 1000,
      budgetTotal: null,
      args: {},
      cwd: "/tmp",
      runId: "r1",
      emit: () => {},
      now: () => 0,
      makeIsolatedCwd: async (key) => ({ cwd: "/wt/" + key, cleanup }),
    });

    await rt.agent("p", { label: "a", isolation: "worktree" });

    // key format: `${seq}:${phase}:${label}` — first agent: seq=0, phase="default", label="a"
    expect(runner.lastCwd()).toBe("/wt/0:default:a");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses deps.cwd when isolation is not requested and never calls makeIsolatedCwd", async () => {
    const makeIsolatedCwd = vi.fn(async (_key: string) => ({
      cwd: "/wt/should-not-be-used",
      cleanup: vi.fn(async () => undefined as void),
    }));
    const runner = createRecordingRunner({
      text: "ok",
      data: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
    });

    const rt = createRuntime({
      runner,
      semaphore: createSemaphore(8),
      journal: createJournal(),
      maxAgents: 1000,
      budgetTotal: null,
      args: {},
      cwd: "/tmp",
      runId: "r1",
      emit: () => {},
      now: () => 0,
      makeIsolatedCwd,
    });

    await rt.agent("p", { label: "a" });

    expect(runner.lastCwd()).toBe("/tmp");
    expect(makeIsolatedCwd).not.toHaveBeenCalled();
  });
});
