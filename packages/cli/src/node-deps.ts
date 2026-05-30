import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { createProcessRunner, detectAdapters } from "@workflow/adapters";
import { startUi } from "@workflow/ui";
import type { AppDeps } from "./app.js";
import { createRegistry, type RegistryFs } from "./registry.js";
import { loadConfig, type WorkflowConfig } from "./config.js";
import type { ConsentIO } from "./consent.js";
import { createAnthropicComplete } from "./anthropic.js";

const tryRead = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** Write a file, creating its parent directory first — the one place this pattern lives. */
const writeFileEnsured = (p: string, data: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};

function makeNodeFs(): RegistryFs {
  return {
    mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true }),
    writeFile: writeFileEnsured,
    appendFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, data);
    },
    readFile: tryRead,
    readDir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    exists: (p) => fs.existsSync(p),
  };
}

function makeReadlineIO(): ConsentIO {
  return {
    question: (prompt) =>
      new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (answer) => {
          rl.close();
          resolve(answer);
        });
      }),
    write: (text) => void process.stdout.write(text),
  };
}

function persistConsent(homeDir: string, project: string, name: string): void {
  const configPath = path.join(homeDir, ".workflow", "config.json");
  let config: WorkflowConfig = {};
  const raw = tryRead(configPath);
  if (raw !== undefined) {
    try {
      config = JSON.parse(raw) as WorkflowConfig;
    } catch {
      config = {};
    }
  }
  const consents: Record<string, Record<string, boolean>> = { ...config.consents };
  consents[project] = { ...consents[project], [name]: true };
  writeFileEnsured(configPath, JSON.stringify({ ...config, consents }, null, 2));
}

/** Build the real, effectful AppDeps wired to the host (fs / process / Ink / harnesses). */
export async function buildNodeDeps(cliPath: string): Promise<AppDeps> {
  const homeDir = os.homedir();
  const cwd = process.cwd();
  const cores = os.cpus().length;
  const vars = process.env;
  const nodeFs = makeNodeFs();
  const registry = createRegistry({ root: path.join(homeDir, ".workflow", "runs"), fs: nodeFs });
  const config = loadConfig({ readFile: tryRead, homeDir, cwd, cores, env: vars });
  const detected = await detectAdapters();
  const complete = createAnthropicComplete(vars["ANTHROPIC_API_KEY"], config.adapters?.["raw-api"]?.model);

  return {
    registry,
    config,
    clock: {
      now: () => Date.now(),
      rand: () => Math.random(),
      pid: () => process.pid,
      hash: (s) => crypto.createHash("sha256").update(s).digest("hex"),
    },
    env: {
      cwd,
      homeDir,
      tmpDir: path.join(os.tmpdir(), "workflow-worktrees"),
      bundledDir: path.resolve(path.dirname(cliPath), "..", "..", "..", "examples"),
      cores,
      vars,
      isTTY: Boolean(process.stdout.isTTY),
      ci: vars["CI"] === "true" || vars["CI"] === "1",
    },
    io: {
      readText: tryRead,
      writeText: writeFileEnsured,
    },
    adapters: {
      processRunner: createProcessRunner(),
      detected,
      ...(complete ? { complete } : {}),
    },
    ui: {
      start: startUi,
      print: (text) => void process.stdout.write(text),
    },
    consent: {
      io: makeReadlineIO(),
      persist: (project, name) => persistConsent(homeDir, project, name),
    },
    proc: {
      spawnDetached: (runId) => {
        const child = spawn(process.execPath, [cliPath, "__run-detached", runId], { detached: true, stdio: "ignore" });
        child.unref();
        return child.pid ?? 0;
      },
      kill: (pid, signal) => void process.kill(pid, signal),
      onSigterm: (handler) => void process.on("SIGTERM", handler),
      watchEvents: (runId, onChange) => {
        const watcher = fs.watch(registry.runDir(runId), () => onChange());
        return () => watcher.close();
      },
    },
  };
}
