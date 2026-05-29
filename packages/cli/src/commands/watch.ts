import type { AppDeps } from "../app.js";
import { subscribeToRun } from "../tail.js";

/** Attach the UI (or line-log) to a running/finished run by tailing its event log. */
export function watchCommand(runId: string, deps: AppDeps): number {
  const meta = deps.registry.readMeta(runId);
  if (!meta) {
    deps.print(`error: no run ${runId}\n`);
    return 1;
  }
  const sub = subscribeToRun({
    readEvents: () => deps.registry.readEvents(runId),
    watch: (onChange) => deps.watchEvents(runId, onChange),
  });
  deps.startUi({
    initial: sub.initial,
    subscribe: sub.subscribe,
    adapter: meta.adapter,
    isTTY: deps.isTTY,
    write: deps.print,
  });
  return 0;
}
