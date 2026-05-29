import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import type { ProcessRunner } from "./process-runner.js";
import { extractJson, compileJsonSchemaValidator } from "./json.js";
import { runWithSchemaRetry } from "./coercion.js";

export interface GenericAdapterConfig {
  readonly id: string;
  readonly command: string;
  readonly promptArg: "stdin" | "last" | { readonly flag: string };
  readonly args?: readonly string[];
  readonly modelFlag?: string;
  readonly schema?: "prompt-inject" | "none";
  readonly maxRetries?: number;
}

export interface GenericAdapterDeps {
  readonly processRunner: ProcessRunner;
}

export function createGenericAdapter(config: GenericAdapterConfig, deps: GenericAdapterDeps): AgentRunner {
  const maxRetries = config.maxRetries ?? 2;
  const useSchema = config.schema === "prompt-inject";
  return {
    id: config.id,
    capabilities: { nativeSchema: false, reportsTokens: false, toolEvents: false },
    run: async (req: AgentRequest, _ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
      let spawnError: WorkflowError | undefined;
      const validate = useSchema && req.schema ? compileJsonSchemaValidator(req.schema) : undefined;

      let result: Awaited<ReturnType<typeof runWithSchemaRetry>>;
      try {
        result = await runWithSchemaRetry({
          validate,
          maxRetries,
          attempt: async (hint) => {
            const schemaInstr = useSchema && req.schema
              ? `\n\nRespond with ONLY JSON matching this schema:\n${JSON.stringify(req.schema)}`
              : "";
            const fullPrompt = `${req.prompt}${schemaInstr}${hint ? `\n\n${hint}` : ""}`;
            const args = [...(config.args ?? [])];
            let stdin: string | undefined;
            if (config.promptArg === "stdin") stdin = fullPrompt;
            else if (config.promptArg === "last") args.push(fullPrompt);
            else args.push(config.promptArg.flag, fullPrompt);
            if (config.modelFlag && req.model) args.push(config.modelFlag, req.model);

            const out = await deps.processRunner.run({
              command: config.command, args, cwd: req.cwd, signal: req.signal,
              ...(stdin !== undefined ? { stdin } : {}),
            });
            if (out.code !== 0) {
              spawnError = { kind: "AdapterSpawn", adapter: config.id, cause: out.stderr || `exit ${out.code}` };
              throw new Error("spawn failed");
            }
            const data = useSchema && req.schema ? extractJson(out.stdout) : undefined;
            return { text: out.stdout, data, usage: { inputTokens: 0, outputTokens: Math.ceil(out.stdout.length / 4) } };
          },
        });
      } catch (e) {
        if (spawnError) return err(spawnError);
        return err({ kind: "AdapterSpawn", adapter: config.id, cause: e instanceof Error ? e.message : String(e) });
      }
      if (result.isErr()) return err(result.error);
      const r = result.value;
      return ok({ text: r.text, ...(r.data !== undefined ? { data: r.data } : {}), usage: { ...r.usage, approximate: true }, toolCalls: [] });
    },
  };
}
