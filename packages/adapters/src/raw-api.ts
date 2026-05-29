import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import { CAPABILITIES } from "./detect.js";

export interface CompletionRequest {
  readonly prompt: string;
  readonly schema?: Record<string, unknown>;
  readonly model?: string;
  readonly signal: AbortSignal;
}

export interface CompletionResult {
  readonly text: string;
  readonly data?: unknown;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface RawApiAdapterDeps {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export function createRawApiAdapter(deps: RawApiAdapterDeps): AgentRunner {
  return {
    id: "raw-api",
    capabilities: CAPABILITIES["raw-api"],
    run: async (req: AgentRequest, _ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
      try {
        const r = await deps.complete({
          prompt: req.prompt,
          ...(req.schema ? { schema: req.schema } : {}),
          ...(req.model ? { model: req.model } : {}),
          signal: req.signal,
        });
        const result: AgentResult = {
          text: r.text,
          ...(r.data !== undefined ? { data: r.data } : {}),
          usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
          toolCalls: [],
        };
        return ok(result);
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        const wErr: WorkflowError = { kind: "AdapterSpawn", adapter: "raw-api", cause };
        return err(wErr);
      }
    },
  };
}
