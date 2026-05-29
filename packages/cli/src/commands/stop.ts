import type { AppDeps } from "../app.js";

/** Stop a backgrounded run: SIGTERM the child pid and mark it stopped. */
export function stopCommand(runId: string, deps: AppDeps): number {
  const meta = deps.registry.readMeta(runId);
  if (!meta) {
    deps.print(`error: no run ${runId}\n`);
    return 1;
  }
  if (meta.status !== "running") {
    deps.print(`run ${runId} is already ${meta.status}\n`);
    return 0;
  }
  if (meta.pid !== null) {
    try {
      deps.killProcess(meta.pid, "SIGTERM");
    } catch {
      // Process already gone — fall through to mark stopped.
    }
  }
  deps.registry.updateMeta(runId, { status: "stopped", endedAt: deps.now() });
  deps.print(`stopped ${runId}\n`);
  return 0;
}
