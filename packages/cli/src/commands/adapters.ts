import { CAPABILITIES, type AdapterId } from "@workflow/adapters";
import type { AppDeps } from "../app.js";

const ALL: readonly AdapterId[] = ["claude", "codex", "copilot", "raw-api"];

/** List the harnesses with their capability matrix and detection status. */
export function adaptersCommand(deps: AppDeps): number {
  for (const id of ALL) {
    const cap = CAPABILITIES[id];
    const present = id === "raw-api" || deps.detected.includes(id);
    const flags = [
      cap.nativeSchema ? "native-schema" : "prompt-schema",
      cap.reportsTokens ? "tokens" : "est-tokens",
      cap.toolEvents ? "tool-events" : "no-tool-events",
    ].join(", ");
    deps.print(`${id.padEnd(8)} ${present ? "(detected)" : "(not on PATH)"}  [${flags}]\n`);
  }
  return 0;
}
