import type { AppDeps } from "../app.js";
import { formatTokens, formatElapsed } from "@workflow/ui";

/** Print the run registry as a table, newest first. */
export function listCommand(deps: Pick<AppDeps, "registry" | "ui" | "clock">): number {
  const runs = [...deps.registry.listRuns()].sort((a, b) => b.startedAt - a.startedAt);
  if (runs.length === 0) {
    deps.ui.print("no runs\n");
    return 0;
  }
  for (const meta of runs) {
    const tokens = deps.registry
      .readJournal(meta.runId)
      .map((entries) => entries.reduce((sum, e) => sum + e.outputTokens, 0))
      .unwrapOr(0);
    const elapsed = (meta.endedAt ?? deps.clock.now()) - meta.startedAt;
    deps.ui.print(
      `${meta.name}  ·  ${meta.status}  ·  ${formatTokens(tokens)} tok  ·  ${formatElapsed(elapsed)}  ·  ${meta.runId}\n`,
    );
  }
  return 0;
}
