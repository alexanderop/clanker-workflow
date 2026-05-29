import type { AppDeps } from "../app.js";
import { saveRun } from "../execute.js";

/** Persist a run's script as a saved workflow (also the UI `s` action). */
export function saveCommand(runId: string, deps: AppDeps): number {
  const path = saveRun(deps, runId);
  if (path === undefined) {
    deps.print(`error: cannot save ${runId} (missing run or script)\n`);
    return 1;
  }
  deps.print(`saved ${path}\n`);
  return 0;
}
