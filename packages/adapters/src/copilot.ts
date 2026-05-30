import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import type { ProcessRunner } from "./process-runner.js";
import { runWithSchemaRetry } from "./coercion.js";
import { extractJson, compileJsonSchemaValidator } from "./json.js";
import { CAPABILITIES } from "./detect.js";
import { translateCopilotLine, extractCopilotFinal } from "./copilot-stream.js";

export interface CopilotAdapterDeps {
  readonly processRunner: ProcessRunner;
  readonly maxRetries?: number;
  readonly bin?: string;
}

export function createCopilotAdapter(deps: CopilotAdapterDeps): AgentRunner {
  const bin = deps.bin ?? "copilot";
  const maxRetries = deps.maxRetries ?? 2;
  return {
    id: "copilot",
    capabilities: CAPABILITIES.copilot,
    run: async (req: AgentRequest, ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
      let spawnError: WorkflowError | undefined;
      const validate = req.schema ? compileJsonSchemaValidator(req.schema) : undefined;
      const onProgress = ctx.onProgress;
      const onLine = onProgress
        ? (line: string): void => {
            for (const p of translateCopilotLine(line)) onProgress(p);
          }
        : undefined;

      let result: Awaited<ReturnType<typeof runWithSchemaRetry>>;
      try {
        result = await runWithSchemaRetry({
          validate,
          maxRetries,
          attempt: async (hint) => {
            const schemaInstr = req.schema
              ? `\n\nRespond with ONLY a JSON value matching this JSON Schema:\n${JSON.stringify(req.schema)}`
              : "";
            const prompt = `${req.prompt}${schemaInstr}${hint ? `\n\n${hint}` : ""}`;
            // `--output-format json` streams events (live progress + final `result`).
            const args = ["-p", prompt, "--output-format", "json", "--allow-all-tools", "--no-ask-user", "--silent", "-C", req.cwd];
            if (req.model) args.push("--model", req.model);
            const out = await deps.processRunner.run({
              command: bin,
              args,
              cwd: req.cwd,
              signal: req.signal,
              ...(onLine ? { onLine } : {}),
            });
            if (out.code !== 0) {
              spawnError = { kind: "AdapterSpawn", adapter: "copilot", cause: out.stderr || `exit ${out.code}` };
              throw new Error("copilot spawn failed");
            }
            const finalRes = extractCopilotFinal(out.stdout);
            if (finalRes.isErr()) {
              spawnError = { kind: "AdapterSpawn", adapter: "copilot", cause: finalRes.error };
              throw new Error("copilot stream parse failed");
            }
            const f = finalRes.value;
            const data = req.schema ? extractJson(f.text) : undefined;
            return { text: f.text, data, usage: { inputTokens: f.usage.inputTokens, outputTokens: f.usage.outputTokens } };
          },
        });
      } catch (e) {
        if (spawnError) return err(spawnError);
        return err({ kind: "AdapterSpawn", adapter: "copilot", cause: e instanceof Error ? e.message : String(e) });
      }
      if (result.isErr()) return err(result.error);
      const r = result.value;
      return ok({
        text: r.text,
        ...(r.data !== undefined ? { data: r.data } : {}),
        usage: r.usage,
        toolCalls: [],
      });
    },
  };
}
