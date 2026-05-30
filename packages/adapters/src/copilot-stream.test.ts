import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { AgentProgress } from "@workflow/core";
import { createCopilotTranslator } from "./copilot-stream.js";

const fixture = readFileSync(new URL("../fixtures/copilot-stream.ndjson", import.meta.url), "utf8");

function drive(translator: ReturnType<typeof createCopilotTranslator>, text: string): AgentProgress[] {
  const out: AgentProgress[] = [];
  for (const line of text.split("\n")) for (const p of translator.push(line)) out.push(p);
  return out;
}

describe("copilot stream translator", () => {
  it("extracts model, tool calls, rising tokens, and final message from the fixture", () => {
    const t = createCopilotTranslator();
    const progress = drive(t, fixture);

    expect(progress.find((p) => p.model)?.model).toBe("claude-sonnet-4.6");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["str_replace_editor", "bash"]);
    // Per-message `outputTokens` accumulate into a cumulative live count (80, then 80+160).
    expect(progress.filter((p) => p.tokens !== undefined).map((p) => p.tokens)).toEqual([80, 240]);

    const final = t.result();
    // Final answer is the last non-empty `assistant.message.content`; the `result`
    // event carries no text in real copilot output.
    expect(final.text).toBe('{"n": 7}');
    expect(final.usage).toEqual({ inputTokens: 0, outputTokens: 240 });
  });

  it("skips session noise lines without emitting tokens", () => {
    const t = createCopilotTranslator();
    expect(t.push('{"type":"session.mcp_servers_loaded","data":{}}')).toEqual([]);
  });
});
