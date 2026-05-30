import { describe, it, expect } from "vitest";
import { createMockRunner, createScriptedRunner } from "@workflow/core";
import type { WorkflowEvent } from "@workflow/core";
import type { StartUiOptions, UiAction } from "@workflow/ui";
import { createRegistry, type RegistryFs, type RunMeta } from "./registry.js";
import { runForeground, runHeadless, saveRun } from "./execute.js";
import type { AppDeps } from "./app.js";

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

// A throwing ProcessRunner proves a --mock / scripted run never spawns a real CLI.
const explodingProcessRunner = {
  run: () => {
    throw new Error("processRunner must not be called in these tests");
  },
};

interface FakeOpts {
  readonly events?: WorkflowEvent[];
  readonly prints?: string[];
  readonly writes?: Array<{ path: string; data: string }>;
  /** Capture the UI's onAction callback so tests can drive controls. */
  readonly captureAction?: (fn: (a: UiAction) => void) => void;
  readonly readTextFile?: (path: string) => string | undefined;
}

function fakeDeps(registry: ReturnType<typeof createRegistry>, opts: FakeOpts = {}): AppDeps {
  return {
    registry,
    config: {},
    cwd: "/tmp",
    homeDir: "/tmp/home",
    tmpDir: "/tmp/tmp",
    cores: 4,
    env: {},
    isTTY: false,
    ci: true,
    now: () => 0,
    rand: () => 0,
    pid: () => 1,
    hash: () => "h",
    processRunner: explodingProcessRunner as AppDeps["processRunner"],
    detected: [],
    readTextFile: opts.readTextFile ?? (() => undefined),
    writeTextFile: (path: string, data: string) => void opts.writes?.push({ path, data }),
    print: (t: string) => void opts.prints?.push(t),
    bundledDir: "/tmp/bundled",
    startUi: (uiOpts: StartUiOptions) => {
      uiOpts.subscribe((e: WorkflowEvent) => opts.events?.push(e));
      if (opts.captureAction && uiOpts.onAction) opts.captureAction(uiOpts.onAction);
      return { unmount: () => {} };
    },
    consentIO: { question: async () => "", write: () => {} },
    persistConsent: () => {},
    spawnDetached: () => 1,
    killProcess: () => {},
    onSigterm: () => {},
    watchEvents: () => () => {},
  } as unknown as AppDeps;
}

const SCHEMA = `{ type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false }`;

const SOURCE = `
import { agent, defineWorkflow } from "defineworkflow";
export default defineWorkflow({
  name: "demo",
  description: "d",
  harness: "claude",
  async run() {
    const a = await agent("first", { label: "a", schema: ${SCHEMA} });
    return { a };
  },
});
`;

// A workflow whose meta declares `output`, so a finished run persists artifacts to disk.
const SOURCE_WITH_OUTPUT = `
import { agent, defineWorkflow } from "defineworkflow";
export default defineWorkflow({
  name: "demo",
  description: "d",
  harness: "claude",
  output: "out",
  async run() {
    await agent("first", { label: "a", schema: ${SCHEMA} });
    return { note: "# Title", count: 3 };
  },
});
`;

function initRegistry(runId: string, source = SOURCE): ReturnType<typeof createRegistry> {
  const registry = createRegistry({ root: "/tmp/runs", fs: memRegistryFs() });
  const meta: RunMeta = {
    runId,
    name: "demo",
    scriptPath: "s.ts",
    args: null,
    adapter: "claude",
    status: "running",
    startedAt: 0,
    endedAt: null,
    pid: null,
    scriptHash: "h",
  };
  registry.init(meta, source);
  return registry;
}

// Scripted runner that answers the agent labelled "a" with a schema-valid object.
function scriptedX(n = 5): ReturnType<typeof createScriptedRunner> {
  return createScriptedRunner({ a: { data: { x: n } } });
}

// Scripted runner that fails the agent labelled "a".
function scriptedFail(): ReturnType<typeof createScriptedRunner> {
  return createScriptedRunner({ a: { fail: { kind: "AdapterSpawn", adapter: "claude", cause: "boom" } } });
}

describe("runForeground", () => {
  it("runs a workflow to completion (mock), journals events, marks the run finished", async () => {
    const registry = initRegistry("fg-1");
    const events: WorkflowEvent[] = [];
    const deps = fakeDeps(registry, { events });

    const code = await runForeground(deps, {
      runId: "fg-1",
      source: SOURCE,
      args: null,
      runner: createMockRunner(),
      adapter: "mock",
      seed: [],
      mock: true,
    });

    expect(code).toBe(0);
    expect(registry.readMeta("fg-1")?.status).toBe("finished");
    expect(registry.readMeta("fg-1")?.endedAt).toBe(0);
    // Events were appended to the registry (not just streamed to listeners).
    const persisted = registry.readEvents("fg-1");
    expect(persisted.some((e) => e.type === "agent-finished")).toBe(true);
    // Listeners (the UI) saw the same stream.
    expect(events.some((e) => e.type === "agent-finished")).toBe(true);
  });

  it("prints a run report on success", async () => {
    const registry = initRegistry("fg-2");
    const prints: string[] = [];
    const deps = fakeDeps(registry, { prints });

    await runForeground(deps, { runId: "fg-2", source: SOURCE, args: null, runner: createMockRunner(), adapter: "mock", seed: [], mock: true });

    const out = prints.join("");
    expect(out).toContain("Run  demo");
    expect(out).toContain("finished");
  });

  it("writes artifacts when meta.output is set", async () => {
    const registry = initRegistry("fg-out", SOURCE_WITH_OUTPUT);
    const prints: string[] = [];
    const writes: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps(registry, { prints, writes });

    const code = await runForeground(deps, {
      runId: "fg-out",
      source: SOURCE_WITH_OUTPUT,
      args: null,
      runner: createMockRunner(),
      adapter: "mock",
      seed: [],
      mock: true,
    });

    expect(code).toBe(0);
    const paths = writes.map((w) => w.path);
    // result.json is always written; the `note` string field becomes its own .md file.
    expect(paths).toContain("/tmp/out/result.json");
    expect(paths.some((p) => p === "/tmp/out/note.md")).toBe(true);
    expect(prints.join("")).toContain("artifacts → /tmp/out");
  });

  it("does not write artifacts when meta.output is unset (terminal only)", async () => {
    const registry = initRegistry("fg-noout");
    const prints: string[] = [];
    const writes: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps(registry, { prints, writes });

    await runForeground(deps, { runId: "fg-noout", source: SOURCE, args: null, runner: createMockRunner(), adapter: "mock", seed: [], mock: true });

    expect(writes.length).toBe(0);
    // The return value is still printed to the terminal.
    expect(prints.join("")).toContain('"a"');
  });

  it("marks the run failed and returns 1 when an agent errors", async () => {
    const registry = initRegistry("fg-err");
    const prints: string[] = [];
    const deps = fakeDeps(registry, { prints });

    const code = await runForeground(deps, {
      runId: "fg-err",
      source: SOURCE,
      args: null,
      runner: scriptedFail(),
      adapter: "claude",
      seed: [],
    });

    expect(code).toBe(1);
    expect(registry.readMeta("fg-err")?.status).toBe("failed");
    const out = prints.join("");
    expect(out).toContain("run failed:");
    // The report still prints, with a failed status.
    expect(out).toContain("Run  demo");
  });

  it("drives UI control actions: pause/resume, save, restart, stop-agent", async () => {
    const registry = initRegistry("fg-actions");
    const writes: Array<{ path: string; data: string }> = [];
    let action: ((a: UiAction) => void) | undefined;
    const deps = fakeDeps(registry, {
      writes,
      captureAction: (fn) => {
        action = fn;
      },
    });

    const code = await runForeground(deps, {
      runId: "fg-actions",
      source: SOURCE,
      args: null,
      runner: createMockRunner(),
      adapter: "mock",
      seed: [],
      mock: true,
    });

    expect(action).toBeDefined();
    // These run after the workflow has finished, but they exercise the
    // pause/restart/save/stop-agent handler branches without throwing.
    action!({ type: "pause" }); // pause
    action!({ type: "pause" }); // resume
    action!({ type: "restart", key: "0:default:a" });
    action!({ type: "stop", target: { scope: "agent", key: "0:default:a" } });
    action!({ type: "save" });

    expect(code).toBe(0);
    // The save action persisted the script snapshot via writeTextFile.
    expect(writes.some((w) => w.path.endsWith("/workflows/demo.ts"))).toBe(true);
  });

  it("stops the run when a run-scoped stop action arrives before execution advances", async () => {
    const registry = initRegistry("fg-stop");
    let action: ((a: UiAction) => void) | undefined;
    const deps = fakeDeps(registry, {
      captureAction: (fn) => {
        action = fn;
        // Abort the run synchronously, before the workflow body advances.
        fn({ type: "stop", target: { scope: "run" } });
      },
    });

    const code = await runForeground(deps, {
      runId: "fg-stop",
      source: SOURCE,
      args: null,
      runner: createMockRunner(),
      adapter: "mock",
      seed: [],
      mock: true,
    });

    expect(action).toBeDefined();
    // A run whose signal was aborted is recorded as stopped; the abort branch is exercised.
    expect(registry.readMeta("fg-stop")?.status).toBe("stopped");
    expect([0, 1]).toContain(code);
  });
});

describe("runHeadless", () => {
  it("runs to completion, appends events to the registry, marks finished, returns 0", async () => {
    const registry = initRegistry("hl-1");
    const deps = fakeDeps(registry);
    const controller = new AbortController();

    const code = await runHeadless(deps, { runId: "hl-1", source: SOURCE, args: null, runner: scriptedX(), adapter: "claude", seed: [] }, controller);

    expect(code).toBe(0);
    expect(registry.readMeta("hl-1")?.status).toBe("finished");
    expect(registry.readEvents("hl-1").some((e) => e.type === "agent-finished")).toBe(true);
  });

  it("writes artifacts when meta.output is set", async () => {
    const registry = initRegistry("hl-out", SOURCE_WITH_OUTPUT);
    const writes: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps(registry, { writes });
    const controller = new AbortController();

    const code = await runHeadless(deps, { runId: "hl-out", source: SOURCE_WITH_OUTPUT, args: null, runner: scriptedX(), adapter: "claude", seed: [] }, controller);

    expect(code).toBe(0);
    expect(writes.map((w) => w.path)).toContain("/tmp/out/result.json");
  });

  it("marks the run failed and returns 1 when an agent errors", async () => {
    const registry = initRegistry("hl-err");
    const deps = fakeDeps(registry);
    const controller = new AbortController();

    const code = await runHeadless(deps, { runId: "hl-err", source: SOURCE, args: null, runner: scriptedFail(), adapter: "claude", seed: [] }, controller);

    expect(code).toBe(1);
    expect(registry.readMeta("hl-err")?.status).toBe("failed");
  });

  it("records a stopped status when the controller is already aborted", async () => {
    const registry = initRegistry("hl-stop");
    const deps = fakeDeps(registry);
    const controller = new AbortController();
    controller.abort();

    const code = await runHeadless(deps, { runId: "hl-stop", source: SOURCE, args: null, runner: scriptedX(), adapter: "claude", seed: [] }, controller);

    // An aborted run is recorded as stopped, never finished.
    expect(registry.readMeta("hl-stop")?.status).toBe("stopped");
    expect([0, 1]).toContain(code);
  });
});

describe("saveRun", () => {
  it("saves to the personal dir when no project .workflow/config.json exists", () => {
    const registry = initRegistry("save-1");
    const writes: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps(registry, { writes, readTextFile: () => undefined });

    const path = saveRun(deps, "save-1");

    expect(path).toBe("/tmp/home/.workflow/workflows/demo.ts");
    expect(writes[0]?.path).toBe("/tmp/home/.workflow/workflows/demo.ts");
    expect(writes[0]?.data).toBe(SOURCE);
  });

  it("saves to the project dir when project .workflow/config.json exists", () => {
    const registry = initRegistry("save-2");
    const writes: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps(registry, {
      writes,
      readTextFile: (p) => (p === "/tmp/.workflow/config.json" ? "{}" : undefined),
    });

    const path = saveRun(deps, "save-2");

    expect(path).toBe("/tmp/.workflow/workflows/demo.ts");
  });

  it("returns undefined when the run has no meta", () => {
    const registry = createRegistry({ root: "/tmp/runs", fs: memRegistryFs() });
    const deps = fakeDeps(registry);

    expect(saveRun(deps, "missing")).toBeUndefined();
  });
});
