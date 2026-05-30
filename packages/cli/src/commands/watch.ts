import type { AppDeps } from "../app.js";
import { subscribeToRun } from "../tail.js";

/** Attach the UI (or line-log) to a running/finished run by tailing its event log. */
export function watchCommand(runId: string, deps: Pick<AppDeps, "registry" | "ui" | "proc" | "env">): number {
  const meta = deps.registry.readMeta(runId);
  if (!meta) {
    deps.ui.print(`error: no run ${runId}\n`);
    return 1;
  }
  const sub = subscribeToRun({
    readEvents: () => deps.registry.readEvents(runId),
    watch: (onChange) => deps.proc.watchEvents(runId, onChange),
  });
  deps.ui.start({
    initial: sub.initial,
    subscribe: sub.subscribe,
    adapter: meta.adapter,
    isTTY: deps.env.isTTY,
    write: deps.ui.print,
  });
  return 0;
}
