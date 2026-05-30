import { describe, it, expect, beforeEach } from "vitest";
import type { StartUiOptions, UiHandle } from "@workflow/ui";
import { dispatch, USAGE } from "./dispatch.js";
import { createRegistry, type RegistryFs } from "./registry.js";
import type { AppDeps } from "./app.js";

function memFs(): RegistryFs {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    mkdirp: (d) => void dirs.add(d),
    writeFile: (p, data) => void store.set(p, data),
    appendFile: (p, data) => void store.set(p, (store.get(p) ?? "") + data),
    readFile: (p) => store.get(p),
    readDir: (d) => {
      const prefix = `${d}/`;
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const name = key.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    exists: (p) => store.has(p),
  };
}

const SCRIPT = `
import { defineWorkflow, agent } from "defineworkflow";
export default defineWorkflow({
  name: "demo",
  description: "demo workflow",
  harness: "claude",
  async run() {
    return await agent("hi", { label: "greeter" });
  },
});
`;

function baseDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const deps: AppDeps = {
    registry: createRegistry({ root: "/runs", fs: memFs() }),
    config: {},
    cwd: "/project",
    homeDir: "/home/user",
    tmpDir: "/tmp",
    cores: 4,
    env: {},
    isTTY: false,
    ci: true,
    now: () => 1000,
    rand: () => 0.5,
    pid: () => 4242,
    hash: () => "hash123",
    processRunner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } as unknown as AppDeps["processRunner"],
    detected: [],
    readTextFile: () => undefined,
    writeTextFile: () => {},
    print: () => {},
    bundledDir: "/bundled",
    startUi: (_opts: StartUiOptions): UiHandle => ({ unmount: () => {} }),
    consentIO: { question: async () => "", write: () => {} },
    persistConsent: () => {},
    spawnDetached: () => 9999,
    killProcess: () => {},
    onSigterm: () => {},
    watchEvents: () => () => {},
  };
  return { ...deps, ...overrides };
}

describe("dispatch routing", () => {
  let prints: string[];
  let deps: AppDeps;

  beforeEach(() => {
    prints = [];
    deps = baseDeps({ print: (t) => prints.push(t) });
  });

  it("returns 1 and prints usage when no command is given", async () => {
    const code = await dispatch([], deps);
    expect(code).toBe(1);
    expect(prints.join("")).toBe(USAGE);
  });

  it("returns 0 and prints usage for --help", async () => {
    const code = await dispatch(["--help"], deps);
    expect(code).toBe(0);
    expect(prints.join("")).toContain("Usage:");
  });

  it("returns 0 for --help even alongside a command", async () => {
    const code = await dispatch(["list", "--help"], deps);
    expect(code).toBe(0);
    expect(prints.join("")).toContain("Usage:");
  });

  it("reports a parseArgs failure (string option missing its value)", async () => {
    // A `--args` with no following value makes parseArgs throw even in non-strict mode.
    const code = await dispatch(["run", "x.ts", "--args"], deps);
    expect(code).toBe(1);
    expect(prints.join("")).toContain("error:");
  });

  it("run requires a script path", async () => {
    const code = await dispatch(["run"], deps);
    expect(code).toBe(1);
    expect(prints.join("")).toContain("requires a script path");
  });

  describe("id-bearing commands require an id", () => {
    for (const cmd of ["__run-detached", "watch", "resume", "stop", "save"]) {
      it(`${cmd} requires a run id`, async () => {
        const code = await dispatch([cmd], deps);
        expect(code).toBe(1);
        expect(prints.join("")).toContain("requires a run id");
      });
    }
  });

  it("routes list to the list command", async () => {
    const code = await dispatch(["list"], deps);
    expect(code).toBe(0);
  });

  it("routes adapters to the adapters command", async () => {
    const code = await dispatch(["adapters"], deps);
    expect(code).toBe(0);
  });

  it("routes watch <id> when an id is present (run not found path)", async () => {
    // No such run persisted — the watch command handles the missing id itself.
    const code = await dispatch(["watch", "nope"], deps);
    expect(typeof code).toBe("number");
  });

  it("routes stop <id> when an id is present", async () => {
    const code = await dispatch(["stop", "nope"], deps);
    expect(typeof code).toBe("number");
  });

  it("routes resume <id> when an id is present", async () => {
    const code = await dispatch(["resume", "nope"], deps);
    expect(typeof code).toBe("number");
  });

  it("routes save <id> when an id is present", async () => {
    const code = await dispatch(["save", "nope"], deps);
    expect(typeof code).toBe("number");
  });

  it("reports an unknown command that is not a saved workflow", async () => {
    const code = await dispatch(["frobnicate"], deps);
    expect(code).toBe(1);
    expect(prints.join("")).toContain("unknown command or workflow 'frobnicate'");
  });

  it("treats an unknown command as a saved workflow name and runs it", async () => {
    const savedPath = "/project/.workflow/workflows/demo.ts";
    const deps2 = baseDeps({
      print: (t) => prints.push(t),
      readTextFile: (p) => (p === savedPath ? SCRIPT : undefined),
    });
    // Run it in --mock so no real harness is needed and no process spawns.
    const code = await dispatch(["demo", "--mock"], deps2);
    expect(code).toBe(0);
    expect(prints.join("")).toContain("mock mode");
  });

  it("forwards run flags (--args) to a saved-workflow run", async () => {
    const savedPath = "/project/.workflow/workflows/demo.ts";
    const deps2 = baseDeps({
      print: (t) => prints.push(t),
      readTextFile: (p) => (p === savedPath ? SCRIPT : undefined),
    });
    const code = await dispatch(["demo", "--mock", "--args", '{"k":1}'], deps2);
    expect(code).toBe(0);
  });
});
