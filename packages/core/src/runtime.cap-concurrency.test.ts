import { describe, it, expect } from "vitest";
import { createRuntime } from "./runtime.js";
import { createScriptedRunner } from "./scripted-runner.js";
import { createJournal } from "./journal.js";
import { createSemaphore } from "./semaphore.js";

describe("agent cap under concurrency", () => {
  it("never lets more than maxAgents reach the runner, even when launched in parallel", async () => {
    const runner = createScriptedRunner({}, { delayMs: 5 });
    const r = createRuntime({
      runner,
      semaphore: createSemaphore(8), // wide — the cap, not the semaphore, must bound spawns
      journal: createJournal(),
      maxAgents: 3,
      budgetTotal: null,
      args: {},
      cwd: "/tmp",
      runId: "r",
      emit: () => {},
      now: () => 0,
    });

    const results = await r.parallel(
      Array.from({ length: 10 }, (_, i) => () => r.agent("p", { label: `x${i}` })),
    );

    // Exactly maxAgents reached the runner; the rest were rejected (AgentCapExceeded -> null).
    expect(runner.callCount()).toBe(3);
    expect(results.filter((x) => x === null).length).toBe(7);
  });
});
