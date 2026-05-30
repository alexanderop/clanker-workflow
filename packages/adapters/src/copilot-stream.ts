import { ok, err, type Result } from "neverthrow";
import type { AgentProgress } from "@workflow/core";
import { isRecord, numberOr, parseLine, stringOrUndefined } from "./stream.js";

/**
 * Copilot `--output-format json` emits one JSON object per line:
 *  - `session.*`             → model id (only useful field on the otherwise-noisy session events)
 *  - `assistant.tool_call`   → tools
 *  - `assistant.message_delta`/`assistant.turn_end` → token usage
 *  - `result`                → final assistant text + real usage
 */
export function translateCopilotLine(line: string): readonly AgentProgress[] {
  const obj = parseLine(line);
  if (!obj) return [];
  const type = obj["type"];

  if (typeof type === "string" && type.startsWith("session.")) {
    const model = stringOrUndefined(obj["model"]);
    return model ? [{ model }] : [];
  }

  if (type === "assistant.tool_call") {
    const name = stringOrUndefined(obj["name"]);
    return name ? [{ tool: { name, ...(obj["arguments"] !== undefined ? { input: obj["arguments"] } : {}) } }] : [];
  }

  if (type === "assistant.message_delta" || type === "assistant.turn_end") {
    const usage = obj["usage"];
    if (isRecord(usage) && typeof usage["output_tokens"] === "number") return [{ tokens: usage["output_tokens"] }];
    return [];
  }

  return [];
}

export interface CopilotFinal {
  readonly text: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly model?: string;
}

/** Extract the final assistant text + usage from the `result` event of the stream. */
export function extractCopilotFinal(stdout: string): Result<CopilotFinal, string> {
  let result: Record<string, unknown> | undefined;
  let model: string | undefined;
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line);
    if (!obj) continue;
    if (typeof obj["type"] === "string" && obj["type"].startsWith("session.") && model === undefined) {
      model = stringOrUndefined(obj["model"]);
    }
    if (obj["type"] === "result") result = obj;
  }
  if (!result) return err("no result event in copilot stream output");
  const text = stringOrUndefined(result["text"]) ?? stringOrUndefined(result["result"]) ?? "";
  const usage = isRecord(result["usage"]) ? result["usage"] : undefined;
  return ok({
    text,
    usage: { inputTokens: numberOr(usage?.["input_tokens"]), outputTokens: numberOr(usage?.["output_tokens"]) },
    ...(model !== undefined ? { model } : {}),
  });
}
