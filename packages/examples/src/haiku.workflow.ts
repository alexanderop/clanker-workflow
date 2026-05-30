// A minimal real workflow: one agent() call.
//
// Run it from this package:
//   pnpm --filter @workflow/examples haiku
//
// …or directly with the CLI from anywhere:
//   workflow run packages/examples/src/haiku.workflow.ts --yes
//
// `defineWorkflow` makes `harness` type-safe for package users: editors will
// autocomplete the valid harnesses ("claude" | "codex" | "copilot" |
// "raw-api") and `tsc` rejects typos before the CLI runs. `harness` is required
// and is the single source of truth (no auto-detect,
// no CLI/config override). This spawns a real agent, so it will use tokens.

import { agent, defineWorkflow, log, phase } from "defineworkflow";

export default defineWorkflow({
  name: "haiku",
  description: "Ask an agent to write a haiku about durable workflows",
  harness: "copilot",
  phases: [{ title: "Write" }],

  async run() {
    phase("Write");
    log("asking the agent for a haiku…");

    const poem = await agent("Write a haiku about durable, crash-safe workflows. Return only the haiku.", {
      label: "haiku-writer",
      phase: "Write",
    });

    return { poem };
  },
});
