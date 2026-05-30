import type { AgentProgress, ToolEvent } from "@workflow/core";
import { parseJsonLine, type StreamTranslator, type TranslatorResult } from "./stream.js";

/**
 * Translator for `copilot --output-format json` (GitHub Copilot CLI ≥1.0).
 *
 * Real copilot NDJSON nests every payload under `data` and, unlike claude/codex,
 * its terminal `result` event carries **no answer text and no token counts** — it
 * only reports `exitCode` and wall-clock usage. So the answer and tokens are read
 * from the assistant stream instead:
 * - `session.*` → model (`data.model`), otherwise skipped as noise
 * - `tool.execution_start` → one tool event (`data.toolName` + `data.arguments`)
 * - `assistant.message` → final text (`data.content`, last non-empty wins) and
 *   per-message `data.outputTokens` accumulated into a cumulative live token count
 * - `result` → only an error signal (`exitCode !== 0`)
 */
export function createCopilotTranslator(): StreamTranslator {
  let model: string | undefined;
  let text = "";
  let cumulativeOutput = 0; // running total across assistant messages, for live tokens
  let isError = false;
  let errorMessage: string | undefined;

  // Payloads live under `data` in real output; fall back to the event itself so a
  // flatter/older shape still parses.
  const dataOf = (ev: Record<string, unknown>): Record<string, unknown> =>
    ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : ev;

  return {
    push(line): readonly AgentProgress[] {
      const ev = parseJsonLine(line);
      if (!ev) return [];
      const type = typeof ev.type === "string" ? ev.type : "";
      const data = dataOf(ev);

      if (type.startsWith("session")) {
        const m = typeof data.model === "string" ? data.model : undefined;
        if (m !== undefined && m !== model) {
          model = m;
          return [{ model }];
        }
        return [];
      }

      if (type === "tool.execution_start") {
        const name = typeof data.toolName === "string" ? data.toolName : undefined;
        if (!name) return [];
        const input = data.arguments ?? data.input;
        return [{ tool: input !== undefined ? { name, input } : ({ name } as ToolEvent) }];
      }

      if (type === "assistant.message") {
        const out: AgentProgress[] = [];
        const m = typeof data.model === "string" ? data.model : undefined;
        if (m !== undefined) model = m;
        // `content` is the consolidated message text; the last non-empty one is the
        // final answer (earlier turns may be empty when they only carried tool calls).
        const content = typeof data.content === "string" ? data.content : undefined;
        if (content !== undefined && content !== "") text = content;
        // Each message reports its own `outputTokens`; sum them for a cumulative live
        // count (the `result` event carries no tokens to correct it with).
        const tokens = typeof data.outputTokens === "number" ? data.outputTokens : undefined;
        if (tokens !== undefined) {
          cumulativeOutput += tokens;
          out.push(model !== undefined ? { tokens: cumulativeOutput, model } : { tokens: cumulativeOutput });
        }
        return out;
      }

      if (type === "result") {
        const exitCode = typeof ev.exitCode === "number" ? ev.exitCode : undefined;
        if (exitCode !== undefined && exitCode !== 0) {
          isError = true;
          errorMessage = `copilot exited ${exitCode}`;
        }
        return [];
      }

      return [];
    },
    result(): TranslatorResult {
      return {
        text,
        usage: { inputTokens: 0, outputTokens: cumulativeOutput },
        ...(isError ? { isError } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      };
    },
  };
}
