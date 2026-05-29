import type { AppDeps } from "../app.js";
import { buildRunner } from "../adapter-select.js";
import { runForeground } from "../execute.js";
import { formatError } from "../format-error.js";

/** Replay a run's journal and run the remaining agents live (design §7). */
export async function resumeCommand(runId: string, deps: AppDeps): Promise<number> {
  const meta = deps.registry.readMeta(runId);
  if (!meta) {
    deps.print(`error: no run ${runId}\n`);
    return 1;
  }
  const source = deps.registry.readScript(runId);
  if (source === undefined) {
    deps.print(`error: missing script snapshot for ${runId}\n`);
    return 1;
  }
  // Same-script guarantee: the snapshot must match the hash recorded at run time.
  if (deps.hash(source) !== meta.scriptHash) {
    deps.print(`error: ${formatError({ kind: "JournalCorrupt", runId, detail: "script snapshot does not match recorded hash" })}\n`);
    return 1;
  }
  const seedResult = deps.registry.readJournal(runId);
  if (seedResult.isErr()) {
    deps.print(`error: ${formatError(seedResult.error)}\n`);
    return 1;
  }
  const runnerResult = buildRunner(meta.adapter, deps.config, { processRunner: deps.processRunner, complete: deps.complete });
  if (runnerResult.isErr()) {
    deps.print(`error: ${formatError(runnerResult.error)}\n`);
    return 1;
  }

  deps.registry.updateMeta(runId, { status: "running", endedAt: null, pid: deps.pid() });
  return runForeground(deps, {
    runId,
    source,
    args: meta.args,
    runner: runnerResult.value,
    adapter: meta.adapter,
    seed: seedResult.value,
  });
}
