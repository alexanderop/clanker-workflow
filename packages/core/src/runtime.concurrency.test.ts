import { describe, it, expect } from "vitest";
import { createRuntime } from "./runtime.js";
import { createScriptedRunner } from "./scripted-runner.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";

describe("concurrency cap", () => {
  it("never runs more agents than the semaphore limit at once", async () => {
    const runner = createScriptedRunner({}, { delayMs: 10 });
    const r = createRuntime({
      runner,
      semaphore: createSemaphore(3),
      journal: createJournal(),
      maxAgents: 1000,
      budgetTotal: null,
      args: {},
      cwd: "/tmp",
      runId: "r",
      emit: () => {},
      now: () => 0,
    });

    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, runner.inFlight());
    }, 1);

    await r.parallel(Array.from({ length: 12 }, (_, i) => () => r.agent("p", { label: `x${i}` })));
    clearInterval(sampler);

    expect(peak).toBeLessThanOrEqual(3);
  });
});
