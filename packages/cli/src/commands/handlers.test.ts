import { describe, it, expect } from "vitest";
import type { StartUiOptions, UiHandle } from "@workflow/ui";
import type { WorkflowEvent } from "@workflow/core";
import { listCommand } from "./list.js";
import { adaptersCommand } from "./adapters.js";
import { stopCommand } from "./stop.js";
import { saveCommand } from "./save.js";
import { watchCommand } from "./watch.js";
import { resumeCommand } from "./resume.js";
import { runDetachedCommand } from "./run-detached.js";
import type { AppDeps } from "../app.js";
import { createRegistry, type RegistryFs, type RunMeta } from "../registry.js";

function memFs(seed: Record<string, string> = {}): RegistryFs {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  return {
    mkdirp: (dir) => dirs.add(dir),
    writeFile: (p, data) => void files.set(p, data),
    appendFile: (p, data) => void files.set(p, (files.get(p) ?? "") + data),
    readFile: (p) => files.get(p),
    // Derive immediate child names of `dir` from the directories created via mkdirp,
    // so listRuns() (which reads the runs root) sees each initialized run.
    readDir: (dir) =>
      [...dirs]
        .filter((d) => d.startsWith(dir + "/"))
        .map((d) => d.slice(dir.length + 1).split("/")[0]!),
    exists: (p) => files.has(p) || dirs.has(p),
  };
}

// A ProcessRunner that throws proves no real CLI is spawned by these handlers.
const explodingProcessRunner = {
  run: () => {
    throw new Error("processRunner must not be called");
  },
};

function capture(): { print: (t: string) => void; out: () => string } {
  const lines: string[] = [];
  return { print: (t) => lines.push(t), out: () => lines.join("") };
}

function fakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    registry: createRegistry({ root: "/runs", fs: memFs() }),
    config: {},
    cwd: "/proj",
    homeDir: "/home",
    tmpDir: "/tmp/wt",
    bundledDir: "/bundled",
    cores: 4,
    env: {},
    isTTY: false,
    ci: true,
    now: () => 1000,
    rand: () => 0,
    pid: () => 4242,
    hash: (s: string) => `h:${s.length}`,
    processRunner: explodingProcessRunner as AppDeps["processRunner"],
    detected: [],
    readTextFile: () => undefined,
    writeTextFile: () => {},
    print: () => {},
    startUi: (_opts: StartUiOptions): UiHandle => ({ unmount: () => {} }),
    consentIO: { question: async () => "", write: () => {} },
    persistConsent: () => {},
    spawnDetached: () => 4321,
    killProcess: () => {},
    onSigterm: () => {},
    watchEvents: () => () => {},
    ...overrides,
  } as unknown as AppDeps;
}

const SOURCE = `export const meta = { name: "demo", description: "d", harness: "raw-api" } as const
const m = await agent("hi", { label: "a" });
return { m };`;

function seedRun(deps: AppDeps, runId: string, overrides: Partial<RunMeta> = {}): void {
  const meta: RunMeta = {
    runId,
    name: "demo",
    scriptPath: "s.ts",
    args: null,
    adapter: "raw-api",
    status: "running",
    startedAt: 0,
    endedAt: null,
    pid: null,
    scriptHash: `h:${SOURCE.length}`,
    ...overrides,
  };
  deps.registry.init(meta, SOURCE);
}

describe("listCommand", () => {
  it("prints 'no runs' on an empty registry", () => {
    const c = capture();
    expect(listCommand(fakeDeps({ print: c.print }))).toBe(0);
    expect(c.out()).toContain("no runs");
  });

  it("lists runs newest-first with status, tokens and elapsed", () => {
    const c = capture();
    const deps = fakeDeps({ print: c.print });
    seedRun(deps, "old", { name: "alpha", startedAt: 10, status: "finished", endedAt: 20 });
    seedRun(deps, "new", { name: "beta", startedAt: 100, status: "running" });
    expect(listCommand(deps)).toBe(0);
    const out = c.out();
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    // newest (beta, startedAt 100) is printed before oldest (alpha, startedAt 10)
    expect(out.indexOf("beta")).toBeLessThan(out.indexOf("alpha"));
  });
});

describe("adaptersCommand", () => {
  it("lists every adapter, marking detected vs not-on-PATH", () => {
    const c = capture();
    expect(adaptersCommand(fakeDeps({ detected: ["claude"], print: c.print }))).toBe(0);
    const out = c.out();
    expect(out).toContain("claude");
    expect(out).toContain("(detected)");
    expect(out).toContain("raw-api"); // always present (no binary)
    expect(out).toContain("(not on PATH)"); // codex/copilot undetected
    expect(out).toContain("native-schema");
  });
});

describe("stopCommand", () => {
  it("reports an unknown run", () => {
    const c = capture();
    expect(stopCommand("nope", fakeDeps({ print: c.print }))).toBe(1);
    expect(c.out()).toContain("no run nope");
  });

  it("is a no-op for an already-finished run", () => {
    const c = capture();
    const deps = fakeDeps({ print: c.print });
    seedRun(deps, "r", { status: "finished" });
    expect(stopCommand("r", deps)).toBe(0);
    expect(c.out()).toContain("already finished");
  });

  it("SIGTERMs the child pid and marks the run stopped", () => {
    const c = capture();
    const killed: Array<{ pid: number; signal: string }> = [];
    const deps = fakeDeps({ print: c.print, killProcess: (pid, sig) => void killed.push({ pid, signal: sig }) });
    seedRun(deps, "r", { status: "running", pid: 555 });
    expect(stopCommand("r", deps)).toBe(0);
    expect(killed).toEqual([{ pid: 555, signal: "SIGTERM" }]);
    expect(deps.registry.readMeta("r")?.status).toBe("stopped");
    expect(c.out()).toContain("stopped r");
  });

  it("still marks the run stopped when the process is already gone", () => {
    const c = capture();
    const deps = fakeDeps({
      print: c.print,
      killProcess: () => {
        throw new Error("ESRCH");
      },
    });
    seedRun(deps, "r", { status: "running", pid: 555 });
    expect(stopCommand("r", deps)).toBe(0);
    expect(deps.registry.readMeta("r")?.status).toBe("stopped");
  });

  it("marks a running run with no pid as stopped without killing", () => {
    const c = capture();
    const deps = fakeDeps({ print: c.print });
    seedRun(deps, "r", { status: "running", pid: null });
    expect(stopCommand("r", deps)).toBe(0);
    expect(deps.registry.readMeta("r")?.status).toBe("stopped");
  });
});

describe("saveCommand", () => {
  it("reports when the run cannot be saved", () => {
    const c = capture();
    expect(saveCommand("missing", fakeDeps({ print: c.print }))).toBe(1);
    expect(c.out()).toContain("cannot save missing");
  });

  it("persists the run script and prints the destination", () => {
    const c = capture();
    const written: Array<{ path: string; data: string }> = [];
    const deps = fakeDeps({ print: c.print, writeTextFile: (path, data) => void written.push({ path, data }) });
    seedRun(deps, "r");
    expect(saveCommand("r", deps)).toBe(0);
    expect(c.out()).toContain("saved");
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toContain("demo.ts");
    expect(written[0]!.data).toBe(SOURCE);
  });
});

describe("watchCommand", () => {
  it("reports an unknown run", () => {
    const c = capture();
    expect(watchCommand("nope", fakeDeps({ print: c.print }))).toBe(1);
    expect(c.out()).toContain("no run nope");
  });

  it("attaches the UI to an existing run via the event tail", () => {
    let started = false;
    let seenInitial: readonly WorkflowEvent[] | undefined;
    const deps = fakeDeps({
      startUi: (opts: StartUiOptions): UiHandle => {
        started = true;
        seenInitial = opts.initial;
        return { unmount: () => {} };
      },
    });
    seedRun(deps, "r");
    deps.registry.appendEvent("r", { type: "log", message: "hello", at: 0 });
    expect(watchCommand("r", deps)).toBe(0);
    expect(started).toBe(true);
    expect(seenInitial?.some((e) => e.type === "log")).toBe(true);
  });
});

describe("resumeCommand", () => {
  it("reports an unknown run", async () => {
    const c = capture();
    expect(await resumeCommand("nope", fakeDeps({ print: c.print }))).toBe(1);
    expect(c.out()).toContain("no run nope");
  });

  it("errors when the snapshot hash does not match the recorded hash", async () => {
    const c = capture();
    // hash() returns `h:<len>`; force a mismatch by recording a different hash.
    const deps = fakeDeps({ print: c.print });
    seedRun(deps, "r", { scriptHash: "h:does-not-match" });
    expect(await resumeCommand("r", deps)).toBe(1);
    expect(c.out()).toContain("JournalCorrupt");
  });
});

describe("runDetachedCommand", () => {
  it("returns 1 when the run meta is missing", async () => {
    expect(await runDetachedCommand("missing", fakeDeps())).toBe(1);
  });
});
