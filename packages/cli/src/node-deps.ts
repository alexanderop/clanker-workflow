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

function makeNodeFs(): RegistryFs {
  return {
    mkdirp: (dir) => void fs.mkdirSync(dir, { recursive: true }),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    },
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
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ ...config, consents }, null, 2));
}

/** Build the real, effectful AppDeps wired to the host (fs / process / Ink / harnesses). */
export async function buildNodeDeps(cliPath: string): Promise<AppDeps> {
  const homeDir = os.homedir();
  const cwd = process.cwd();
  const cores = os.cpus().length;
  const env = process.env;
  const nodeFs = makeNodeFs();
  const registry = createRegistry({ root: path.join(homeDir, ".workflow", "runs"), fs: nodeFs });
  const config = loadConfig({ readFile: tryRead, homeDir, cwd, cores, env });
  const detected = await detectAdapters();
  const complete = createAnthropicComplete(env["ANTHROPIC_API_KEY"], config.adapters?.["raw-api"]?.model);

  return {
    registry,
    config,
    cwd,
    homeDir,
    tmpDir: path.join(os.tmpdir(), "workflow-worktrees"),
    bundledDir: path.resolve(path.dirname(cliPath), "..", "..", "..", "examples"),
    cores,
    env,
    isTTY: Boolean(process.stdout.isTTY),
    ci: env["CI"] === "true" || env["CI"] === "1",
    now: () => Date.now(),
    rand: () => Math.random(),
    pid: () => process.pid,
    hash: (s) => crypto.createHash("sha256").update(s).digest("hex"),
    processRunner: createProcessRunner(),
    ...(complete ? { complete } : {}),
    detected,
    readTextFile: tryRead,
    writeTextFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    },
    print: (text) => void process.stdout.write(text),
    startUi,
    consentIO: makeReadlineIO(),
    persistConsent: (project, name) => persistConsent(homeDir, project, name),
    spawnDetached: (runId) => {
      const child = spawn(process.execPath, [cliPath, "__run-detached", runId], { detached: true, stdio: "ignore" });
      child.unref();
      return child.pid ?? 0;
    },
    killProcess: (pid, signal) => void process.kill(pid, signal),
    onSigterm: (handler) => void process.on("SIGTERM", handler),
    watchEvents: (runId, onChange) => {
      const watcher = fs.watch(registry.runDir(runId), () => onChange());
      return () => watcher.close();
    },
  };
}
