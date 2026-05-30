import type { AppDeps } from "../app.js";
import { buildRunner } from "../adapter-select.js";
import { runForeground } from "../execute.js";
import { formatError } from "../format-error.js";

/** Replay a run's journal and run the remaining agents live (design §7). */
export async function resumeCommand(
  runId: string,
  deps: Pick<AppDeps, "registry" | "config" | "clock" | "env" | "io" | "adapters" | "ui">,
): Promise<number> {
  const meta = deps.registry.readMeta(runId);
  if (!meta) {
    deps.ui.print(`error: no run ${runId}\n`);
    return 1;
  }
  const source = deps.registry.readScript(runId);
  if (source === undefined) {
    deps.ui.print(`error: missing script snapshot for ${runId}\n`);
    return 1;
  }
  // Same-script guarantee: the snapshot must match the hash recorded at run time.
  if (deps.clock.hash(source) !== meta.scriptHash) {
    deps.ui.print(`error: ${formatError({ kind: "JournalCorrupt", runId, detail: "script snapshot does not match recorded hash" })}\n`);
    return 1;
  }
  const seedResult = deps.registry.readJournal(runId);
  if (seedResult.isErr()) {
    deps.ui.print(`error: ${formatError(seedResult.error)}\n`);
    return 1;
  }
  const runnerResult = buildRunner(meta.adapter, deps.config, { processRunner: deps.adapters.processRunner, complete: deps.adapters.complete });
  if (runnerResult.isErr()) {
    deps.ui.print(`error: ${formatError(runnerResult.error)}\n`);
    return 1;
  }

  deps.registry.updateMeta(runId, { status: "running", endedAt: null, pid: deps.clock.pid() });
  return runForeground(deps, {
    runId,
    source,
    args: meta.args,
    runner: runnerResult.value,
    adapter: meta.adapter,
    seed: seedResult.value,
  });
}
