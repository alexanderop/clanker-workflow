import { describe, it, expect } from "vitest";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { createRuntime } from "./runtime.js";
import { createControlRegistry } from "./control.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";
import type { AgentRequest, AgentResult, AgentRunner, RunCtx } from "./types.js";
import type { WorkflowError } from "./errors.js";
import type { WorkflowEvent } from "./events.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface ControllableRunner extends AgentRunner {
  callCount(label: string): number;
  /** Resolve the most recent pending run for a label with a normal ok result. */
  resolve(label: string, text: string): void;
}

/**
 * A runner that is observably in-flight: each run() returns a deferred promise
 * the test resolves later, and it observes its abort signal (returning an
 * "agent stopped" err when aborted). createScriptedRunner cannot do this.
 */
function createControllableRunner(): ControllableRunner {
  const counts = new Map<string, number>();
  // Per label, a stack of pending deferreds (so a restart can target the latest run).
  const pending = new Map<string, Array<Deferred<Result<AgentResult, WorkflowError>>>>();

  const run = (req: AgentRequest, _ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
    const label = req.label ?? "";
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const d = deferred<Result<AgentResult, WorkflowError>>();
    const stack = pending.get(label) ?? [];
    stack.push(d);
    pending.set(label, stack);

    req.signal.addEventListener("abort", () => {
      d.resolve(err({ kind: "AdapterSpawn", adapter: "scripted", cause: "agent stopped" }));
    });

    return d.promise;
  };

  return {
    id: "scripted",
    capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: false },
    run,
    callCount: (label) => counts.get(label) ?? 0,
    resolve: (label, text) => {
      const stack = pending.get(label);
      const d = stack?.[stack.length - 1];
      if (d) d.resolve(ok({ text, data: undefined, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] }));
    },
  };
}

describe("AgentControl: per-agent stop", () => {
  it("stopAgent aborts just that agent, leaving others unaffected", async () => {
    const events: WorkflowEvent[] = [];
    const runner = createControllableRunner();
    const control = createControlRegistry();
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

    // Launch two agents concurrently — different labels → different keys.
    const pendingA = rt.agent("p", { label: "a" });
    const pendingB = rt.agent("p", { label: "b" });

    // First agent gets seq 0, second seq 1; phase defaults to "default".
    const keyA = "0:default:a";
    const keyB = "1:default:b";

    // Let both reach in-flight (agent-started emitted).
    await Promise.resolve();
    await Promise.resolve();
    expect(events.filter((e) => e.type === "agent-started").map((e) => e.key)).toEqual([keyA, keyB]);

    // Stop just agent A.
    control.stopAgent(keyA);

    await expect(pendingA).rejects.toMatchObject({ workflowError: { cause: "agent stopped" } });
    expect(events.some((e) => e.type === "agent-failed" && e.key === keyA)).toBe(true);
    expect(events.some((e) => e.type === "agent-failed" && e.key === keyB)).toBe(false);

    // Agent B is unaffected — resolve it normally.
    runner.resolve("b", "done-b");
    await expect(pendingB).resolves.toBe("done-b");
    expect(events.some((e) => e.type === "agent-failed" && e.key === keyB)).toBe(false);
  });
});

describe("AgentControl: per-agent restart", () => {
  it("restartAgent re-invokes the runner with the same key, no agent-failed emitted", async () => {
    const events: WorkflowEvent[] = [];
    const runner = createControllableRunner();
    const control = createControlRegistry();
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

    const pending = rt.agent("p", { label: "a" });
    const key = "0:default:a";

    await Promise.resolve();
    expect(runner.callCount("a")).toBe(1);

    // Restart: re-run with a fresh controller, same key/seq.
    control.restartAgent(key);

    // The first run is aborted; the loop should issue a second run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.callCount("a")).toBe(2);

    // Resolve the second invocation normally.
    runner.resolve("a", "second");
    await expect(pending).resolves.toBe("second");

    // A successful restart is not a failure.
    expect(events.some((e) => e.type === "agent-failed" && e.key === key)).toBe(false);
  });
});
