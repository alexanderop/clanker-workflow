import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "@workflow/schema";
import { createProcessRunner } from "./process-runner.js";
import { detectAdapters } from "./detect.js";
import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import { createCopilotAdapter } from "./copilot.js";

const ENABLED = process.env.WORKFLOW_E2E === "1";
const d = ENABLED ? describe : describe.skip;

d("real-CLI adapter smoke (costs tokens)", () => {
  const schema = toJsonSchema(z.object({ answer: z.number() }))._unsafeUnwrap();
  const prompt = "Return JSON with key 'answer' set to the number 42. Output only the JSON.";

  it("detects installed harnesses", async () => {
    const present = await detectAdapters();
    expect(Array.isArray(present)).toBe(true);
  });

  it("claude returns schema-valid structured output (if installed)", async () => {
    const present = await detectAdapters();
    if (!present.includes("claude")) return;
    const adapter = createClaudeAdapter({ processRunner: createProcessRunner() });
    const res = await adapter.run({ prompt, schema, cwd: process.cwd(), signal: AbortSignal.timeout(120_000) }, { runId: "e2e", seq: 0 });
    expect(res.isOk()).toBe(true);
    expect((res._unsafeUnwrap().data as { answer: number }).answer).toBe(42);
  }, 130_000);

  it("codex returns schema-valid structured output (if installed)", async () => {
    const present = await detectAdapters();
    if (!present.includes("codex")) return;
    const adapter = createCodexAdapter({ processRunner: createProcessRunner() });
    const res = await adapter.run({ prompt, schema, cwd: process.cwd(), signal: AbortSignal.timeout(120_000) }, { runId: "e2e", seq: 0 });
    expect(res.isOk()).toBe(true);
  }, 130_000);

  it("copilot returns schema-valid structured output (if installed)", async () => {
    const present = await detectAdapters();
    if (!present.includes("copilot")) return;
    const adapter = createCopilotAdapter({ processRunner: createProcessRunner() });
    const res = await adapter.run({ prompt, schema, cwd: process.cwd(), signal: AbortSignal.timeout(120_000) }, { runId: "e2e", seq: 0 });
    expect(res.isOk()).toBe(true);
  }, 130_000);
});
