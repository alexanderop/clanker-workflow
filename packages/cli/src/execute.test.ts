import { describe, it, expect } from "vitest";
import { createMockRunner } from "@workflow/core";
import type { WorkflowEvent } from "@workflow/core";
import type { ProcessRunner } from "@workflow/adapters";
import { createRegistry, type RegistryFs, type RunMeta } from "./registry.js";
import { runForeground } from "./execute.js";
import { fakeDeps as makeFakeDeps } from "./test-support.js";

function memRegistryFs(): RegistryFs {
  const files = new Map<string, string>();
  return {
    mkdirp: () => {},
    writeFile: (p, data) => void files.set(p, data),
    appendFile: (p, data) => void files.set(p, (files.get(p) ?? "") + data),
    readFile: (p) => files.get(p),
    readDir: () => [],
    exists: (p) => files.has(p),
  };
}

// A throwing ProcessRunner proves a --mock run never spawns a real CLI.
const explodingProcessRunner: ProcessRunner = {
  run: () => {
    throw new Error("processRunner must not be called during a --mock run");
  },
};

/** A fake AppDeps whose UI forwards every event to `events`, with adapters that explode if spawned. */
function fakeDeps(registry: ReturnType<typeof createRegistry>, events: WorkflowEvent[]) {
  return makeFakeDeps({
    registry,
    // codex IS detected — so without --mock, the per-call `adapter: "codex"` override
    // would resolve to the real codex adapter and hit the exploding processRunner.
    adapters: { processRunner: explodingProcessRunner, detected: ["codex"] },
    ui: {
      start: (opts) => {
        opts.subscribe((e: WorkflowEvent) => events.push(e));
        return { unmount: () => {} };
      },
    },
  }).deps;
}

const SOURCE = `
import { agent, defineWorkflow } from "defineworkflow";
export default defineWorkflow({
  name: "mocktest",
  description: "d",
  harness: "claude",
  async run() {
    const schema = { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false };
    const a = await agent("first", { label: "a", schema });
    const b = await agent("second", { label: "b", adapter: "codex", schema });
    return { a, b };
  },
});
`;

describe("runForeground with --mock", () => {
  it("runs a workflow to completion using the mock runner without spawning processes", async () => {
    const registry = createRegistry({ root: "/tmp/runs", fs: memRegistryFs() });
    const runId = "mocktest-1";
    const meta: RunMeta = { runId, name: "mocktest", scriptPath: "s.ts", args: null, adapter: "claude", status: "running", startedAt: 0, endedAt: null, pid: null, scriptHash: "h" };
    registry.init(meta, SOURCE);
    const events: WorkflowEvent[] = [];
    const deps = fakeDeps(registry, events);

    const code = await runForeground(deps, {
      runId,
      source: SOURCE,
      args: null,
      runner: createMockRunner(),
      adapter: "mock",
      seed: [],
      mock: true,
    });

    expect(code).toBe(0);
    expect(registry.readMeta(runId)?.status).toBe("finished");
    // Both agents finished — including the one with a per-call `adapter: "codex"` override,
    // which proves --mock also intercepts per-call adapter dispatch.
    const finished = events.filter((e) => e.type === "agent-finished");
    expect(finished.length).toBe(2);
  });

  it("prints a run report when the foreground run finishes", async () => {
    const registry = createRegistry({ root: "/tmp/runs", fs: memRegistryFs() });
    const runId = "mocktest-2";
    const meta: RunMeta = { runId, name: "mocktest", scriptPath: "s.ts", args: null, adapter: "claude", status: "running", startedAt: 0, endedAt: null, pid: null, scriptHash: "h" };
    registry.init(meta, SOURCE);
    const events: WorkflowEvent[] = [];
    const prints: string[] = [];
    const base = fakeDeps(registry, events);
    const deps = { ...base, ui: { ...base.ui, print: (t: string) => void prints.push(t) } };

    await runForeground(deps, { runId, source: SOURCE, args: null, runner: createMockRunner(), adapter: "mock", seed: [], mock: true });

    const out = prints.join("");
    expect(out).toContain("Run  mocktest");
    expect(out).toContain("finished");
    expect(out).toContain("Tokens");
    expect(out).toContain("Agents");
  });
});
