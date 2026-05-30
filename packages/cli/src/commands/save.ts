import type { AppDeps } from "../app.js";
import { saveRun } from "../execute.js";

/** Persist a run's script as a saved workflow (also the UI `s` action). */
export function saveCommand(runId: string, deps: Pick<AppDeps, "registry" | "env" | "io" | "ui">): number {
  const path = saveRun(deps, runId);
  if (path === undefined) {
    deps.ui.print(`error: cannot save ${runId} (missing run or script)\n`);
    return 1;
  }
  deps.ui.print(`saved ${path}\n`);
  return 0;
}
