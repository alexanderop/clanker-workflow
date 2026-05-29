import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import type { ProcessRunner } from "./process-runner.js";
import { CAPABILITIES } from "./detect.js";

export interface ClaudeAdapterDeps {
  readonly processRunner: ProcessRunner;
  readonly maxRetries?: number;
  readonly bin?: string;
}

interface ClaudeResult {
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly is_error?: boolean;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps): AgentRunner {
  const bin = deps.bin ?? "claude";
  return {
    id: "claude",
    capabilities: CAPABILITIES.claude,
    run: async (req: AgentRequest, _ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
      const args = ["-p", req.prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--add-dir", req.cwd];
      if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
      if (req.model) args.push("--model", req.model);

      const out = await deps.processRunner.run({ command: bin, args, cwd: req.cwd, signal: req.signal });
      if (out.code !== 0) {
        const e: WorkflowError = { kind: "AdapterSpawn", adapter: "claude", cause: out.stderr || `exit ${out.code}` };
        return err(e);
      }

      let parsed: ClaudeResult;
      try {
        parsed = JSON.parse(out.stdout) as ClaudeResult;
      } catch (e) {
        return err({ kind: "AdapterSpawn", adapter: "claude", cause: `unparseable result: ${e instanceof Error ? e.message : String(e)}` });
      }
      if (parsed.is_error) {
        return err({ kind: "AdapterSpawn", adapter: "claude", cause: "claude reported is_error" });
      }

      // `result` is the assistant's text (a JSON string when a schema is requested).
      // `structured_output` is the already-parsed object when --json-schema is used.
      const text = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? "");

      let data: unknown;
      if (req.schema) {
        if (parsed.structured_output !== undefined) {
          data = parsed.structured_output;
        } else if (typeof parsed.result === "string") {
          try {
            data = JSON.parse(parsed.result);
          } catch {
            return err({ kind: "AdapterSpawn", adapter: "claude", cause: "result was not valid JSON for the schema" });
          }
        } else {
          data = parsed.result;
        }
      }

      const result: AgentResult = {
        text,
        ...(data !== undefined ? { data } : {}),
        usage: { inputTokens: parsed.usage?.input_tokens ?? 0, outputTokens: parsed.usage?.output_tokens ?? 0 },
        toolCalls: [],
      };
      return ok(result);
    },
  };
}
