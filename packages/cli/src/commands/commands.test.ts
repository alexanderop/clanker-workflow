import { describe, it, expect } from "vitest";
import { startUi } from "@workflow/ui";
import type { AppDeps } from "../app.js";
import { createRegistry, type RegistryFs } from "../registry.js";
import { dispatch } from "../dispatch.js";

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
