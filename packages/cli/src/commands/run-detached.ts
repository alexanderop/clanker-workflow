import type { AppDeps } from "../app.js";
import { buildRunner } from "../adapter-select.js";
import { runHeadless } from "../execute.js";

/** Hidden `__run-detached <runId>` body: executed by the forked child to run a backgrounded workflow. */
export async function runDetachedCommand(
  runId: string,
  deps: Pick<AppDeps, "registry" | "config" | "clock" | "env" | "io" | "adapters" | "ui" | "proc">,
): Promise<number> {
  const meta = deps.registry.readMeta(runId);
  if (!meta) return 1;
  const source = deps.registry.readScript(runId);
  if (source === undefined) return 1;

  const runnerResult = buildRunner(meta.adapter, deps.config, { processRunner: deps.adapters.processRunner, complete: deps.adapters.complete });
  if (runnerResult.isErr()) {
    deps.registry.updateMeta(runId, { status: "failed", endedAt: deps.clock.now() });
    return 1;
  }

  deps.registry.updateMeta(runId, { pid: deps.clock.pid() });
  const controller = new AbortController();
  deps.proc.onSigterm(() => controller.abort());

  return runHeadless(deps, { runId, source, args: meta.args, runner: runnerResult.value, adapter: meta.adapter, seed: [] }, controller);
}
