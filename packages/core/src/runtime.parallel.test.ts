import { describe, it, expect } from "vitest";
import { createRuntime } from "./runtime.js";
import { createScriptedRunner } from "./scripted-runner.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";

function rt(responses = {}, opts = {}) {
  return createRuntime({
    runner: createScriptedRunner(responses, opts),
    semaphore: createSemaphore(8),
    journal: createJournal(),
    maxAgents: 1000,
    budgetTotal: null,
    args: {},
    cwd: "/tmp",
    runId: "r",
    emit: () => {},
    now: () => 0,
  });
}

describe("parallel", () => {
  it("awaits all thunks (barrier) and returns results in order", async () => {
    const r = rt({ a: { text: "A" }, b: { text: "B" }, c: { text: "C" } });
    const out = await r.parallel([
      () => r.agent("p", { label: "a" }),
      () => r.agent("p", { label: "b" }),
      () => r.agent("p", { label: "c" }),
    ]);
    expect(out).toEqual(["A", "B", "C"]);
  });

  it("maps a failing thunk to null instead of rejecting the whole call", async () => {
    const r = rt({ a: { text: "A" }, b: { fail: { kind: "AdapterSpawn", adapter: "x", cause: "boom" } } });
    const out = await r.parallel([
      () => r.agent("p", { label: "a" }),
      () => r.agent("p", { label: "b" }),
    ]);
    expect(out).toEqual(["A", null]);
  });
});
