import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createRuntime } from "./runtime.js";
import { createScriptedRunner } from "./scripted-runner.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";
import type { WorkflowEvent } from "./events.js";

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
