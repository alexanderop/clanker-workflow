import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import type { LoadedWorkflow } from "./runtime.js";
import { createScriptedRunner } from "./scripted-runner.js";
import { createControlRegistry } from "./control.js";
import type { ControlRegistry } from "./control.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";
import type { WorkflowEvent } from "./events.js";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx } from "./types.js";
import { ok, err } from "neverthrow";

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

  it("returns validated data when a JSON Schema is given", async () => {
    const { rt } = harness({ "a": { data: { n: 7 } } });
    const out = await rt.agent("give n", {
      label: "a",
      schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    });
    expect(out).toEqual({ n: 7 });
  });

  it("accepts a zod schema, converting it before validating the agent's data", async () => {
    const { rt } = harness({ "a": { data: { n: 7 } } });
    const out = await rt.agent("give n", { label: "a", schema: z.object({ n: z.number() }) });
    expect(out).toEqual({ n: 7 });
  });

  it("rejects data that violates a zod schema with a SchemaValidation error", async () => {
    const { rt } = harness({ "a": { text: "n is five", data: { n: "five" } } });
    await expect(
      rt.agent("give n", { label: "a", schema: z.object({ n: z.number() }) }),
    ).rejects.toMatchObject({ workflowError: { kind: "SchemaValidation" } });
  });

  it("surfaces the model's raw output when re-validation fails", async () => {
    const { rt } = harness({ "a": { text: "I think n is five", data: { n: "five" } } });
    await expect(
      rt.agent("give n", {
        label: "a",
        schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      }),
    ).rejects.toMatchObject({
      workflowError: { kind: "SchemaValidation", rawOutput: "I think n is five" },
    });
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

describe("runtime.agent progress + labels", () => {
  // A runner that drives ctx.onProgress with a scripted sequence before resolving.
  function progressRunner(updates: ReadonlyArray<Parameters<NonNullable<RunCtx["onProgress"]>>[0]>): AgentRunner {
    return {
      id: "p",
      capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: true },
      run: async (_req: AgentRequest, ctx: RunCtx) => {
        for (const u of updates) ctx.onProgress?.(u);
        return ok<AgentResult>({ text: "done", usage: { inputTokens: 0, outputTokens: 1 }, toolCalls: [] });
      },
    };
  }

  function progressHarness(runner: AgentRunner, now: () => number) {
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
      now,
    });
    return { rt, events };
  }

  it("emits agent-tool per tool call observed via onProgress", async () => {
    const runner = progressRunner([{ tool: { name: "WebFetch", input: { url: "x" } } }, { tool: { name: "WebSearch" } }]);
    const { rt, events } = progressHarness(runner, () => 0);
    await rt.agent("p", { label: "a" });
    const tools = events.filter((e) => e.type === "agent-tool");
    expect(tools.map((t) => (t as { tool: { name: string } }).tool.name)).toEqual(["WebFetch", "WebSearch"]);
  });

  it("coalesces token/model progress to <=1/sec and carries model into agent-finished", async () => {
    let clock = 0;
    // first update at t=0 (emits), second at t=500 (dropped), third at t=1500 (emits)
    const times = [0, 500, 1500, 2000];
    const now = () => times[clock++] ?? 9999;
    const runner = progressRunner([
      { tokens: 100, model: "claude-opus-4-8[1m]" },
      { tokens: 200 },
      { tokens: 300 },
    ]);
    const { rt, events } = progressHarness(runner, now);
    await rt.agent("p", { label: "a" });
    const progress = events.filter((e) => e.type === "agent-progress") as Array<{ tokens?: number; model?: string }>;
    expect(progress.length).toBe(2);
    expect(progress[0]).toMatchObject({ tokens: 100, model: "claude-opus-4-8[1m]" });
    expect(progress[1]?.tokens).toBe(300);
    const finished = events.find((e) => e.type === "agent-finished") as { model?: string };
    expect(finished.model).toBe("claude-opus-4-8[1m]");
  });

  it("derives an agent label from the prompt's first non-empty line when unlabeled", async () => {
    const { rt, events } = progressHarness(progressRunner([]), () => 0);
    await rt.agent("\n  Use the WebFetch tool to gather posts\nmore detail here");
    const queued = events.find((e) => e.type === "agent-queued") as { label: string };
    expect(queued.label).toBe("Use the WebFetch tool to gather posts");
  });
});

describe("runtime.workflow (nested child runtimes)", () => {
  function deps(over: Record<string, unknown> = {}) {
    const events: WorkflowEvent[] = [];
    return {
      events,
      base: {
        runner: createScriptedRunner({ a: { text: "x", outputTokens: 5 } }),
        semaphore: createSemaphore(8),
        journal: createJournal(),
        maxAgents: 1000,
        budgetTotal: null as number | null,
        args: {},
        cwd: "/tmp",
        runId: "r1",
        emit: (e: WorkflowEvent) => events.push(e),
        now: () => 0,
        ...over,
      },
    };
  }

  it("throws when no workflow resolver is configured", async () => {
    const { base } = deps();
    const rt = createRuntime(base);
    await expect(rt.workflow("child")).rejects.toMatchObject({
      workflowError: { kind: "AdapterSpawn", adapter: "workflow" },
    });
  });

  it("runs a child workflow that shares the parent budget and forwards args", async () => {
    let seenArgs: unknown;
    const resolveWorkflow = async (name: string, _childArgs?: unknown): Promise<LoadedWorkflow> => {
      expect(name).toBe("child");
      return {
        meta: { name: "child", description: "d", harness: "claude", phases: [] },
        run: async (rt, args) => {
          seenArgs = args;
          await rt.agent("p", { label: "a" }); // spends 5 against the shared budget
          return "child-done";
        },
      };
    };
    const { base } = deps({ budgetTotal: 100, resolveWorkflow });
    const rt = createRuntime(base);
    const result = await rt.workflow("child", { topic: "x" });
    expect(result).toBe("child-done");
    expect(seenArgs).toEqual({ topic: "x" });
    // The child's agent spend is recorded against the parent's shared budget.
    expect(rt.budget.spent()).toBe(5);
  });

  it("the child runtime exposes the forwarded args via rt.args", async () => {
    let childArgs: unknown;
    const resolveWorkflow = async (): Promise<LoadedWorkflow> => ({
      meta: { name: "child", description: "d", harness: "claude", phases: [] },
      run: async (rt) => {
        childArgs = rt.args;
        return null;
      },
    });
    const { base } = deps({ resolveWorkflow });
    const rt = createRuntime(base);
    await rt.workflow("child", { passed: true });
    expect(childArgs).toEqual({ passed: true });
  });

  it("forbids a second level of nesting: the child's workflow() throws", async () => {
    const resolveWorkflow = async (): Promise<LoadedWorkflow> => ({
      meta: { name: "child", description: "d", harness: "claude", phases: [] },
      run: async (rt) => {
        // A child runtime's workflow() is the one-level guard.
        return rt.workflow("grandchild");
      },
    });
    const { base } = deps({ resolveWorkflow });
    const rt = createRuntime(base);
    await expect(rt.workflow("child")).rejects.toMatchObject({
      workflowError: { kind: "AdapterSpawn", adapter: "workflow", cause: "workflow() nesting is one level only" },
    });
  });
});

describe("runtime restart loop (control registry)", () => {
  /** A runner that fails the first N runs then succeeds, recording how often it ran. */
  function flakyRunner(failures: number): AgentRunner & { runs(): number } {
    let runs = 0;
    return {
      id: "flaky",
      capabilities: { nativeSchema: false, reportsTokens: true, toolEvents: false },
      run: async (_req: AgentRequest, _ctx: RunCtx) => {
        runs++;
        if (runs <= failures) return err({ kind: "AdapterSpawn", adapter: "flaky", cause: "transient" });
        return ok<AgentResult>({ text: "recovered", usage: { inputTokens: 0, outputTokens: 2 }, toolCalls: [] });
      },
      runs: () => runs,
    };
  }

  it("re-runs the agent (same key/seq) when a restart is requested during an errored run", async () => {
    const inner = createControlRegistry();
    const runner = flakyRunner(1); // first run errors, the restart re-runs and succeeds
    const events: WorkflowEvent[] = [];
    // Wrap the real registry: trigger a restart on the first registration so the first
    // (errored) run loops back instead of throwing.
    let triggeredOnce = false;
    const control: ControlRegistry = {
      register: (key, controller, onRestart) => {
        const unregister = inner.register(key, controller, onRestart);
        if (!triggeredOnce) {
          triggeredOnce = true;
          onRestart(); // mark restart=true for the in-flight run
        }
        return unregister;
      },
      stopAgent: (key) => inner.stopAgent(key),
      restartAgent: (key) => inner.restartAgent(key),
    };
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
      control,
    });

    const out = await rt.agent("p", { label: "x" });
    expect(out).toBe("recovered");
    expect(runner.runs()).toBe(2); // errored once, restarted, succeeded
    // The errored first iteration was swallowed by the restart — no agent-failed emitted.
    expect(events.map((e) => e.type)).not.toContain("agent-failed");
    // agent-started re-emitted per iteration.
    expect(events.filter((e) => e.type === "agent-started").length).toBe(2);
  });
});

describe("runtime worktree cleanup", () => {
  it("swallows a failing isolated-cwd cleanup and still returns the agent result", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("rm -rf failed");
    });
    const runner = createScriptedRunner({ a: { text: "ok", outputTokens: 1 } });
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
      makeIsolatedCwd: async () => ({ cwd: "/wt/x", cleanup }),
    });
    const out = await rt.agent("p", { label: "a", isolation: "worktree" });
    expect(out).toBe("ok");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("runtime schema compile gate", () => {
  it("rejects a malformed JSON Schema as SchemaValidation before spawning the runner", async () => {
    const runner = createScriptedRunner({ a: { text: "x" } });
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
    });
    await expect(
      // `type: "not-a-real-type"` is not a valid JSON Schema keyword value — compileValidator throws.
      rt.agent("p", { label: "a", schema: { type: "not-a-real-type" } as never }),
    ).rejects.toMatchObject({ workflowError: { kind: "SchemaValidation", attempts: 0 } });
    expect(runner.callCount()).toBe(0);
  });
});

describe("runtime stop after the pause gate", () => {
  it("a signal aborted while paused short-circuits after the gate, before spawning", async () => {
    const runner = createScriptedRunner({ a: { text: "x" } });
    const controller = new AbortController();
    let release!: () => void;
    const gatePromise = new Promise<void>((r) => (release = r));
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
      now: () => 0,
      gate: () => gatePromise,
      signal: controller.signal,
    });
    const pending = rt.agent("p", { label: "a" });
    await Promise.resolve();
    // Abort happens while the agent is held at the pause gate.
    controller.abort();
    release();
    await expect(pending).rejects.toMatchObject({ workflowError: { kind: "AdapterSpawn", cause: "run stopped" } });
    expect(runner.callCount()).toBe(0);
    expect(events.map((e) => e.type)).toContain("agent-failed");
  });
});

describe("runtime.parallel", () => {
  it("runs thunks concurrently and nulls the ones that throw, preserving order", async () => {
    const { rt } = harness({ ok1: { text: "one" }, ok2: { text: "two" }, boom: { fail: { kind: "AdapterSpawn", adapter: "scripted", cause: "x" } } });
    const out = await rt.parallel([
      () => rt.agent("a", { label: "ok1" }),
      () => rt.agent("b", { label: "boom" }), // throws -> nulled
      () => rt.agent("c", { label: "ok2" }),
    ]);
    expect(out).toEqual(["one", null, "two"]);
  });
});

describe("runtime.pipeline", () => {
  it("threads each item through the stages and returns the final value per item", async () => {
    const { rt } = harness();
    const out = await rt.pipeline(
      [1, 2, 3],
      async (prev) => (prev as number) + 10,
      async (prev) => (prev as number) * 2,
    );
    // (n + 10) * 2
    expect(out).toEqual([22, 24, 26]);
  });

  it("nulls an item whose stage throws, leaving the others intact", async () => {
    const { rt } = harness();
    const out = await rt.pipeline(
      ["keep", "drop", "keep2"],
      async (prev, item) => {
        if (item === "drop") throw new Error("stage failed");
        return `${prev as string}!`;
      },
    );
    expect(out).toEqual(["keep!", null, "keep2!"]);
  });

  it("exposes item and index to each stage", async () => {
    const { rt } = harness();
    const out = await rt.pipeline(
      ["a", "b"],
      async (_prev, item, index) => `${item as string}:${index}`,
    );
    expect(out).toEqual(["a:0", "b:1"]);
  });
});

describe("runtime budget + agent-cap gates", () => {
  function gated(maxAgents: number, budgetTotal: number | null, responses = {}) {
    const events: WorkflowEvent[] = [];
    const rt = createRuntime({
      runner: createScriptedRunner(responses),
      semaphore: createSemaphore(8),
      journal: createJournal(),
      maxAgents,
      budgetTotal,
      args: {},
      cwd: "/tmp",
      runId: "r1",
      emit: (e) => events.push(e),
      now: () => 0,
    });
    return { rt, events };
  }

  it("throws BudgetExhausted once spend reaches the total and emits agent-failed", async () => {
    const { rt, events } = gated(1000, 20, { a: { text: "x", outputTokens: 20 }, b: { text: "y" } });
    await rt.agent("p", { label: "a" }); // spends exactly the total
    await expect(rt.agent("p", { label: "b" })).rejects.toMatchObject({
      workflowError: { kind: "BudgetExhausted", spent: 20, total: 20 },
    });
    expect(events.some((e) => e.type === "agent-failed")).toBe(true);
  });

  it("throws AgentCapExceeded once the spawn cap is reached", async () => {
    const { rt } = gated(1, null, { a: { text: "ok" }, b: { text: "ok" } });
    await rt.agent("p", { label: "a" }); // claims the single slot
    await expect(rt.agent("p", { label: "b" })).rejects.toMatchObject({
      workflowError: { kind: "AgentCapExceeded", cap: 1 },
    });
  });

  it("does not gate on budget when budgetTotal is null (unbounded)", async () => {
    const { rt } = gated(1000, null, { a: { text: "x", outputTokens: 1_000_000 }, b: { text: "y" } });
    await rt.agent("p", { label: "a" });
    // A huge spend does not block the next agent because no cap is set.
    await expect(rt.agent("p", { label: "b" })).resolves.toBe("y");
  });
});

describe("runtime.log and runtime.phase", () => {
  it("log() emits a typed log event and phase() emits phase-started and scopes later agents", async () => {
    const { rt, events } = harness({ a: { text: "x" } });
    rt.log("hello world");
    rt.phase("Build");
    await rt.agent("p", { label: "a" });
    const log = events.find((e) => e.type === "log") as { message: string };
    expect(log.message).toBe("hello world");
    const queued = events.find((e) => e.type === "agent-queued") as { phase: string };
    expect(queued.phase).toBe("Build");
  });
});

describe("journal replay determinism (property)", () => {
  it("replays every pre-recorded seq from cache without invoking the runner, for any count", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 25 }), async (count) => {
        const journal = createJournal();
        for (let i = 0; i < count; i++) {
          journal.record({ seq: i, key: `${i}:default:a`, text: `t${i}`, data: { i }, outputTokens: i });
        }
        const runner = createScriptedRunner({ a: { text: "FRESH", data: { i: -1 } } });
        const rt = createRuntime({
          runner,
          semaphore: createSemaphore(8),
          journal,
          maxAgents: 100000,
          budgetTotal: null,
          args: {},
          cwd: "/tmp",
          runId: "r1",
          emit: () => {},
          now: () => 0,
        });
        const results: unknown[] = [];
        for (let i = 0; i < count; i++) results.push(await rt.agent("p", { label: "a" }));
        // Every result came from the journal, never the live runner.
        expect(runner.callCount()).toBe(0);
        expect(results).toEqual(Array.from({ length: count }, (_, i) => ({ i })));
        // Replayed spend is the sum of journaled output tokens.
        expect(rt.budget.spent()).toBe((count * (count - 1)) / 2);
      }),
      { numRuns: 20 },
    );
  });
});
