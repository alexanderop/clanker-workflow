import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import type { ProcessRunner } from "./process-runner.js";
import { CAPABILITIES } from "./detect.js";
import { translateClaudeLine, extractClaudeFinal } from "./claude-stream.js";

export interface ClaudeAdapterDeps {
  readonly processRunner: ProcessRunner;
  readonly bin?: string;
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps): AgentRunner {
  const bin = deps.bin ?? "claude";
  return {
    id: "claude",
    capabilities: CAPABILITIES.claude,
    run: async (req: AgentRequest, ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
      // Stream JSON so tool calls and rising token counts surface live (the
      // StreamTranslator forwards them via ctx.onProgress). `--verbose` is required
      // alongside stream-json in print mode. YOLO mode: a headless `-p` agent can't
      // answer permission prompts, so skip them entirely.
      const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--add-dir", req.cwd];
      if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
      if (req.model) args.push("--model", req.model);

      const onProgress = ctx.onProgress;
      const onLine = onProgress
        ? (line: string): void => {
            for (const p of translateClaudeLine(line)) onProgress(p);
          }
        : undefined;

      const out = await deps.processRunner.run({
        command: bin,
        args,
        cwd: req.cwd,
        signal: req.signal,
        ...(onLine ? { onLine } : {}),
      });
      if (out.code !== 0) {
        return err({ kind: "AdapterSpawn", adapter: "claude", cause: out.stderr || `exit ${out.code}` });
      }

      const final = extractClaudeFinal(out.stdout);
      if (final.isErr()) {
        return err({ kind: "AdapterSpawn", adapter: "claude", cause: final.error });
      }
      const f = final.value;
      if (req.schema && f.data === undefined) {
        return err({ kind: "AdapterSpawn", adapter: "claude", cause: "schema requested but no structured_output or JSON result present" });
      }

      const result: AgentResult = {
        text: f.text,
        ...(f.data !== undefined ? { data: f.data } : {}),
        usage: { inputTokens: f.usage.inputTokens, outputTokens: f.usage.outputTokens },
        // Tools stream live via onProgress; the runtime emits agent-tool from those.
        toolCalls: [],
      };
      return ok(result);
    },
  };
}
