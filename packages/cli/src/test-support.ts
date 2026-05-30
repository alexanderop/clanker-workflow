import { startUi } from "@workflow/ui";
import type {
  AdapterDeps,
  AppDeps,
  Clock,
  ConsentDeps,
  Env,
  FileIO,
  ProcessControl,
  UiDeps,
} from "./app.js";
import { createRegistry, type RegistryFs, type RunMeta } from "./registry.js";
import type { WorkflowConfig } from "./config.js";

/** Deterministic RunMeta factory — fixed defaults, shallow override. */
export const runMeta = (o: Partial<RunMeta> = {}): RunMeta => ({
  runId: "r1",
  name: "wf",
  scriptPath: null,
  args: {},
  adapter: "codex",
  status: "running",
  startedAt: 0,
  endedAt: null,
  pid: null,
  scriptHash: "h",
  ...o,
});

/** In-memory RegistryFs for tests — also exposes its backing map. */
export function memFs(seed: Record<string, string> = {}): RegistryFs & { files: Map<string, string> } {
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

/** Per-group partial overrides; capability groups merge shallowly, services replace wholesale. */
export interface FakeDepsOverrides {
  registry?: AppDeps["registry"];
  config?: WorkflowConfig;
  clock?: Partial<Clock>;
  env?: Partial<Env>;
  io?: Partial<FileIO>;
  adapters?: Partial<AdapterDeps>;
  ui?: Partial<UiDeps>;
  consent?: Partial<ConsentDeps>;
  proc?: Partial<ProcessControl>;
  /** Seed files for the default in-memory registry/io. */
  _files?: Record<string, string>;
}

/**
 * Build a fake AppDeps wired to in-memory fakes (memFs registry/io, incrementing clock, captured
 * print). Override any group with a shallow partial; `out()` returns everything written via
 * `ui.print` (unless `ui.print` itself is overridden).
 */
export function fakeDeps(o: FakeDepsOverrides = {}): { deps: AppDeps; out: () => string } {
  const fs = memFs(o._files ?? {});
  let out = "";
  let clock = 1000;
  const deps: AppDeps = {
    registry: o.registry ?? createRegistry({ root: "/runs", fs }),
    config: o.config ?? {},
    clock: { now: () => clock++, rand: () => 0.5, pid: () => 4242, hash: (s) => `h:${s.length}`, ...o.clock },
    env: {
      cwd: "/proj",
      homeDir: "/home/me",
      tmpDir: "/tmp/wt",
      bundledDir: "/bundled",
      cores: 12,
      vars: {},
      isTTY: false,
      ci: false,
      ...o.env,
    },
    io: { readText: (p) => fs.readFile(p), writeText: (p, d) => fs.writeFile(p, d), ...o.io },
    adapters: {
      processRunner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      detected: [],
      complete: async () => ({ text: "agent-said-hi", usage: { inputTokens: 1, outputTokens: 5 } }),
      ...o.adapters,
    },
    ui: {
      start: startUi,
      print: (t) => {
        out += t;
      },
      ...o.ui,
    },
    consent: { io: { question: async () => "n", write: () => {} }, persist: () => {}, ...o.consent },
    proc: { spawnDetached: () => 9999, kill: () => {}, onSigterm: () => {}, watchEvents: () => () => {}, ...o.proc },
  };
  return { deps, out: () => out };
}
