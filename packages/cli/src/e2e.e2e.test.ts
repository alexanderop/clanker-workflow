import { describe, it, expect } from "vitest";
import { z } from "zod";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createProcessRunner, detectAdapters, type AdapterId } from "@workflow/adapters";
import { createRuntime, createSemaphore, type AgentRunner } from "@workflow/core";
import { buildRunner } from "./adapter-select.js";
import { createRegistry, type RegistryFs, type RunMeta } from "./registry.js";
import { adaptersCommand } from "./commands/adapters.js";
import type { AppDeps } from "./app.js";

const ENABLED = process.env.WORKFLOW_E2E === "1";
const d = ENABLED ? describe : describe.skip;

function nodeRegistryFs(): RegistryFs {
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
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
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

// Engine path (createRuntime) is used directly rather than runWorkflow(sandbox), because a
// schema-bearing agent requires zod, which the vm sandbox does not expose to workflow scripts.
d("real-CLI e2e per installed adapter (costs tokens; WORKFLOW_E2E=1)", () => {
  const CANDIDATES: readonly AdapterId[] = ["claude", "codex", "copilot"];
  const schema = z.object({ answer: z.number() });
  const prompt = "Return JSON with key 'answer' set to the number 42. Output only the JSON.";

  for (const id of CANDIDATES) {
    it(`${id}: schema output validates, journals, resume reuses cache, adapters lists it`, async () => {
      const present = await detectAdapters();
      if (!present.includes(id)) return; // auto-skip when this harness isn't on PATH

      const built = buildRunner(id, {}, { processRunner: createProcessRunner() });
      expect(built.isOk()).toBe(true);
      const base = built._unsafeUnwrap();

      const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-"));
      const registry = createRegistry({ root, fs: nodeRegistryFs() });
      const runId = `${id}-e2e`;
      const meta: RunMeta = { runId, name: "e2e", scriptPath: null, args: {}, adapter: id, status: "running", startedAt: 0, endedAt: null, pid: null, scriptHash: "h" };
      registry.init(meta, "");

      let calls = 0;
      const counting: AgentRunner = { ...base, run: (req, ctx) => { calls++; return base.run(req, ctx); } };
      const rt = createRuntime({ runner: counting, semaphore: createSemaphore(2), journal: registry.persistentJournal(runId, []), maxAgents: 10, budgetTotal: null, args: {}, cwd: process.cwd(), runId, emit: () => {}, now: () => 0 });
      const out = await rt.agent(prompt, { label: "q", schema });
      expect((out as { answer: number }).answer).toBe(42);
      expect(calls).toBe(1);

      const journalFile = path.join(registry.runDir(runId), "journal.jsonl");
      expect(fs.existsSync(journalFile)).toBe(true);
      const seed = registry.readJournal(runId)._unsafeUnwrap();
      expect(seed).toHaveLength(1);

      // resume: a journal-seeded run returns the cached result with NO new adapter spawn.
      let calls2 = 0;
      const counting2: AgentRunner = { ...base, run: (req, ctx) => { calls2++; return base.run(req, ctx); } };
      const rt2 = createRuntime({ runner: counting2, semaphore: createSemaphore(2), journal: registry.persistentJournal(runId, seed), maxAgents: 10, budgetTotal: null, args: {}, cwd: process.cwd(), runId, emit: () => {}, now: () => 0 });
      const out2 = await rt2.agent(prompt, { label: "q", schema });
      expect((out2 as { answer: number }).answer).toBe(42);
      expect(calls2).toBe(0);

      let printed = "";
      adaptersCommand({ detected: present, print: (t: string) => { printed += t; } } as unknown as AppDeps);
      expect(printed).toContain(id);

      fs.rmSync(root, { recursive: true, force: true });
    }, 130_000);
  }
});
