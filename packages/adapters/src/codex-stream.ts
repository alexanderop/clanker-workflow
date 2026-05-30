import type { AgentProgress } from "@workflow/core";
import { isRecord, numberOr, parseLine, stringOrUndefined } from "./stream.js";

/**
 * Codex `exec --json` emits one JSON object per line:
 *  - `thread.started`/`turn.started` → model id
 *  - `item.completed` with `item.type` `command_execution`/`mcp_tool_call` → tools
 *  - `turn.completed`                → real token usage
 * The final assistant message is read from codex's `-o` output file (authoritative),
 * so this translator only feeds live progress. `thread.started`/`turn.started` noise
 * carries the model.
 */
export function translateCodexLine(line: string): readonly AgentProgress[] {
  const obj = parseLine(line);
  if (!obj) return [];
  const type = obj["type"];

  if (type === "thread.started" || type === "turn.started") {
    const model = stringOrUndefined(obj["model"]);
    return model ? [{ model }] : [];
  }

  if (type === "turn.completed") {
    const usage = obj["usage"];
    if (isRecord(usage) && typeof usage["output_tokens"] === "number") return [{ tokens: usage["output_tokens"] }];
    return [];
  }

  if (type === "item.completed") {
    const item = obj["item"];
    if (!isRecord(item)) return [];
    if (item["type"] === "command_execution") {
      const command = item["command"];
      return [{ tool: { name: "command_execution", ...(command !== undefined ? { input: { command } } : {}) } }];
    }
    if (item["type"] === "mcp_tool_call") {
      const name = stringOrUndefined(item["tool"]) ?? "mcp_tool_call";
      return [{ tool: { name, ...(item["arguments"] !== undefined ? { input: item["arguments"] } : {}) } }];
    }
    return [];
  }

  return [];
}

/** Real final usage from the last `turn.completed` event (codex reports actual tokens). */
export function extractCodexUsage(stdout: string): { readonly inputTokens: number; readonly outputTokens: number } | null {
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line);
    if (obj?.["type"] === "turn.completed" && isRecord(obj["usage"])) {
      usage = { inputTokens: numberOr(obj["usage"]["input_tokens"]), outputTokens: numberOr(obj["usage"]["output_tokens"]) };
    }
  }
  return usage;
}

/** Model id from the first thread/turn init event, if present. */
export function extractCodexModel(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const obj = parseLine(line);
    if (obj?.["type"] === "thread.started" || obj?.["type"] === "turn.started") {
      const model = stringOrUndefined(obj["model"]);
      if (model !== undefined) return model;
    }
  }
  return undefined;
}
