import { describe, it, expect } from "vitest";
import { startUi } from "@workflow/ui";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import type { AppDeps } from "../app.js";
import { createRegistry, type RegistryFs } from "../registry.js";
import { dispatch } from "../dispatch.js";
import { runForeground } from "../execute.js";

function memFs(seed: Record<string, string> = {}): RegistryFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  return {
    files,
    mkdirp: (dir) => dirs.add(dir),
    writeFile: (p, data) => files.set(p, data),
    appendFile: (p, data) => files.set(p, (files.get(p) ?? "") + data),
    readFile: (p) => files.get(p),
    readDir: (dir) => [...dirs].filter((d) => d.startsWith(dir + "/")).map((d) => d.slice(dir.length + 1).split("/")[0]!),
    exists: (p) => files.has(p) || dirs.has(p),
  };
}

function fakeDeps(overrides: Partial<AppDeps> = {}): { deps: AppDeps; out: () => string } {
  const fs = memFs((overrides as { _files?: Record<string, string> })._files ?? {});
  let out = "";
  let clock = 1000;
  const base: AppDeps = {
    registry: createRegistry({ root: "/runs", fs }),
    config: {},
    cwd: "/proj",
    homeDir: "/home/me",
    tmpDir: "/tmp/wt",
    cores: 12,
    env: {},
    isTTY: false,
    ci: false,
    now: () => clock++,
    rand: () => 0.5,
    pid: () => 4242,
    hash: (s) => `h:${s.length}`,
    processRunner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    complete: async () => ({ text: "agent-said-hi", usage: { inputTokens: 1, outputTokens: 5 } }),
    detected: [],
    readTextFile: (p) => fs.readFile(p),
    writeTextFile: (p, data) => fs.writeFile(p, data),
    print: (t) => {
      out += t;
    },
    startUi,
    consentIO: { question: async () => "n", write: () => {} },
    persistConsent: () => {},
    spawnDetached: () => 9999,
    killProcess: () => {},
    onSigterm: () => {},
    watchEvents: () => () => {},
  };
  return { deps: { ...base, ...overrides }, out: () => out };
}

const HELLO = `export const meta = { name: "hello", description: "say hi", phases: [{ title: "Greet" }] } as const
phase("Greet");
const msg = await agent("say hi", { label: "greeter" });
return { msg };`;

describe("dispatch routing", () => {
  it("prints usage and exits non-zero with no command", async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch([], deps)).toBe(1);
    expect(out()).toContain("Usage:");
  });

  it("list reports no runs", async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(["list"], deps)).toBe(0);
    expect(out()).toContain("no runs");
  });

  it("adapters prints the capability matrix", async () => {
    const { deps, out } = fakeDeps();
    await dispatch(["adapters"], deps);
    expect(out()).toContain("raw-api");
    expect(out()).toContain("claude");
  });

  it("an unknown command is reported as an unknown workflow", async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(["nope"], deps)).toBe(1);
    expect(out()).toContain("unknown command or workflow 'nope'");
  });

  it("run errors on a missing script", async () => {
    const { deps, out } = fakeDeps();
    expect(await dispatch(["run", "/missing.ts"], deps)).toBe(1);
    expect(out()).toContain("cannot read script");
  });

  it("run rejects invalid --args JSON", async () => {
    const { deps } = fakeDeps({ _files: { "/h.ts": HELLO } } as Partial<AppDeps>);
    const code = await dispatch(["run", "/h.ts", "--args", "{bad", "--yes"], deps);
    expect(code).toBe(1);
  });
});

describe("dispatch run (end-to-end, line-log)", () => {
  it("runs a workflow via the raw-api adapter and persists a finished run", async () => {
    const fs = memFs({ "/h.ts": HELLO });
    let out = "";
    let clock = 0;
    const deps: AppDeps = {
      ...fakeDeps().deps,
      registry: createRegistry({ root: "/runs", fs }),
      readTextFile: (p) => fs.readFile(p),
      writeTextFile: (p, d) => fs.writeFile(p, d),
      now: () => clock++,
      print: (t) => {
        out += t;
      },
    };

    const code = await dispatch(["run", "/h.ts", "--yes"], deps);
    expect(code).toBe(0);

    const runs = deps.registry.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.name).toBe("hello");
    expect(runs[0]!.status).toBe("finished");
    expect(runs[0]!.adapter).toBe("raw-api");
    // line-log output records the run + the finished agent
    expect(out).toContain("hello");
    expect(out).toContain("greeter");
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface ControllableRunner extends AgentRunner {
  callCount(label: string): number;
  resolve(label: string, text: string): void;
}
function createControllableRunner(): ControllableRunner {
  const counts = new Map<string, number>();
  const pending = new Map<string, Array<Deferred<Result<AgentResult, WorkflowError>>>>();
  return {
    id: "scripted",
    capabilities: { nativeSchema: true, reportsTokens: true, toolEvents: false },
    run: (req: AgentRequest, _ctx: RunCtx) => {
      const label = req.label ?? "";
      counts.set(label, (counts.get(label) ?? 0) + 1);
      const d = deferred<Result<AgentResult, WorkflowError>>();
      const stack = pending.get(label) ?? [];
      stack.push(d);
      pending.set(label, stack);
      req.signal.addEventListener("abort", () =>
        d.resolve(err({ kind: "AdapterSpawn", adapter: "scripted", cause: "agent stopped" })),
      );
      return d.promise;
    },
    callCount: (label) => counts.get(label) ?? 0,
    resolve: (label, text) => {
      const s = pending.get(label);
      const d = s?.[s.length - 1];
      if (d) d.resolve(ok({ text, data: undefined, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] }));
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("runForeground agent control", () => {
  it("agent-scoped stop fails just that agent, others finish", async () => {
    const SOURCE = `export const meta = { name: "t", description: "d" } as const
const r = await parallel([() => agent("x", { label: "a" }), () => agent("y", { label: "b" })]);
return r;`;

    let onAction!: (a: import("@workflow/ui").UiAction) => void;
    const { deps } = fakeDeps({
      startUi: (opts) => {
        onAction = opts.onAction!;
        return { unmount() {} };
      },
    });
    deps.registry.init(
      { runId: "r1", name: "t", scriptPath: null, args: {}, adapter: "codex", status: "running", startedAt: 0, endedAt: null, pid: null, scriptHash: "h" },
      SOURCE,
    );

    const runner = createControllableRunner();
    const p = runForeground(deps, { runId: "r1", source: SOURCE, args: {}, runner, adapter: "codex", seed: [] });
    await flush();

    expect(runner.callCount("a")).toBe(1);
    expect(runner.callCount("b")).toBe(1);

    onAction({ type: "stop", target: { scope: "agent", key: "0:default:a" } });
    runner.resolve("b", "done-b");

    const code = await p;
    expect(code).toBe(0);

    const events = deps.registry.readEvents("r1");
    expect(events.some((e) => e.type === "agent-failed" && e.key === "0:default:a")).toBe(true);
    expect(events.some((e) => e.type === "agent-finished" && e.key === "1:default:b")).toBe(true);
  });

  it("restart yields a second runner call", async () => {
    const SOURCE2 = `export const meta = { name: "t", description: "d" } as const
const v = await agent("x", { label: "a" });
return v;`;

    let onAction!: (a: import("@workflow/ui").UiAction) => void;
    const { deps } = fakeDeps({
      startUi: (opts) => {
        onAction = opts.onAction!;
        return { unmount() {} };
      },
    });
    deps.registry.init(
      { runId: "r2", name: "t", scriptPath: null, args: {}, adapter: "codex", status: "running", startedAt: 0, endedAt: null, pid: null, scriptHash: "h" },
      SOURCE2,
    );

    const runner = createControllableRunner();
    const p = runForeground(deps, { runId: "r2", source: SOURCE2, args: {}, runner, adapter: "codex", seed: [] });
    await flush();

    expect(runner.callCount("a")).toBe(1);

    onAction({ type: "restart", key: "0:default:a" });
    await flush();
    await flush();
    expect(runner.callCount("a")).toBe(2);

    runner.resolve("a", "second");
    const code = await p;
    expect(code).toBe(0);
    expect(runner.callCount("a")).toBe(2);

    const events = deps.registry.readEvents("r2");
    expect(events.some((e) => e.type === "agent-failed" && e.key === "0:default:a")).toBe(false);
  });
});
