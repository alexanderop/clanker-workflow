import { ok, err, type Result } from "neverthrow";
import type { AgentProgress } from "@workflow/core";
import { isRecord, numberOr, parseLine, stringOrUndefined, type StreamFinal } from "./stream.js";

/**
 * Claude `--output-format stream-json --verbose` emits one JSON object per line:
 *  - `system`/`init`  → model id
 *  - `assistant`      → `tool_use` content blocks (tools) + `message.usage.output_tokens`
 *  - `result`         → final text/usage and `structured_output`
 * Noise (`hook_started`/`hook_response`/`rate_limit_event`/`notification`) is skipped.
 */
export function translateClaudeLine(line: string): readonly AgentProgress[] {
  const obj = parseLine(line);
  if (!obj) return [];
  const type = obj["type"];

  if (type === "system") {
    const model = stringOrUndefined(obj["model"]);
    return model ? [{ model }] : [];
  }

  if (type === "assistant") {
    const out: AgentProgress[] = [];
    const message = obj["message"];
    if (isRecord(message)) {
      const content = message["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block["type"] === "tool_use") {
            const name = stringOrUndefined(block["name"]);
            if (name !== undefined) out.push({ tool: { name, input: block["input"] } });
          }
        }
      }
      const usage = message["usage"];
      if (isRecord(usage) && typeof usage["output_tokens"] === "number") {
        out.push({ tokens: usage["output_tokens"] });
      }
    }
    return out;
  }

  return [];
}

/** Extract the final result from the full claude stream (the `result` line). */
export function extractClaudeFinal(stdout: string): Result<StreamFinal, string> {
  let result: Record<string, unknown> | undefined;
  let model: string | undefined;
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line);
    if (!obj) continue;
    if (obj["type"] === "system" && model === undefined) model = stringOrUndefined(obj["model"]);
    if (obj["type"] === "result") result = obj;
  }
  if (!result) return err("no result event in claude stream output");
  if (result["is_error"] === true) return err("claude reported is_error");

  const raw = result["result"];
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");

  let data: unknown;
  if (result["structured_output"] !== undefined) {
    data = result["structured_output"];
  } else if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      // leave undefined: a prose `result` simply has no structured data
    }
  } else if (raw !== undefined && typeof raw === "object") {
    data = raw;
  }

  const usage = isRecord(result["usage"]) ? result["usage"] : undefined;
  return ok({
    text,
    ...(data !== undefined ? { data } : {}),
    usage: {
      inputTokens: numberOr(usage?.["input_tokens"]),
      outputTokens: numberOr(usage?.["output_tokens"]),
    },
    ...(model !== undefined ? { model } : {}),
  });
}
