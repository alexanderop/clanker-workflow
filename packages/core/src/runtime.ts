import { z } from "zod";
import { toJsonSchema, validate } from "@workflow/schema";
import { createBudget, type Budget } from "./budget.js";
import { WorkflowThrow, type WorkflowError } from "./errors.js";
import type { Semaphore } from "./semaphore.js";
import type { Journal } from "./journal.js";
import type { AgentRequest, AgentRunner } from "./types.js";
import type { WorkflowEvent } from "./events.js";

export interface AgentOptions {
  readonly label?: string;
  readonly phase?: string;
  readonly schema?: z.ZodType;
  readonly model?: string;
  readonly agentType?: string;
  readonly adapter?: string;
  readonly isolation?: "worktree";
}

export interface LoadedWorkflow {
  readonly meta: { readonly name: string; readonly description: string; readonly phases?: readonly unknown[] };
  run(runtime: Runtime, args?: unknown): Promise<unknown>;
}

export interface RuntimeDeps {
  readonly runner: AgentRunner;
  readonly semaphore: Semaphore;
  readonly journal: Journal;
  readonly maxAgents: number;
  readonly budgetTotal: number | null;
  readonly args: unknown;
  readonly cwd: string;
  readonly runId: string;
  readonly emit: (event: WorkflowEvent) => void;
  readonly now: () => number;
  readonly resolveWorkflow?: (name: string, args?: unknown) => Promise<LoadedWorkflow>;
}

export interface Runtime {
  readonly args: unknown;
  readonly budget: Budget;
  agent(prompt: string, opts?: AgentOptions): Promise<unknown>;
  parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>>;
  pipeline(items: readonly unknown[], ...stages: ReadonlyArray<(prev: unknown, item: unknown, index: number) => Promise<unknown>>): Promise<Array<unknown | null>>;
  phase(title: string): void;
  log(message: string): void;
  workflow(name: string, args?: unknown): Promise<unknown>;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const budget = createBudget(deps.budgetTotal);
  let currentPhase = "default";
  let seq = 0;
  let spawned = 0;

  const agent = async (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
    const mySeq = seq++;
    const phase = opts.phase ?? currentPhase;
    const label = opts.label ?? `agent-${mySeq}`;
    const key = `${mySeq}:${phase}:${label}`;

    deps.emit({ type: "agent-queued", key, label, phase, prompt, at: deps.now() });

    // Resume: journal hit returns cached result without spawning.
    const cached = deps.journal.lookup(mySeq);
    if (cached) {
      budget.record(cached.outputTokens);
      deps.emit({ type: "agent-output", key, chunk: cached.text, at: deps.now() });
      deps.emit({ type: "agent-finished", key, usage: { inputTokens: 0, outputTokens: cached.outputTokens }, cached: true, at: deps.now() });
      return cached.data ?? cached.text;
    }

    // Budget gate (parity: further agent() calls throw once spent reaches total).
    // Best-effort gate: under concurrency spend may overshoot total by up to (concurrency × per-agent tokens). Spec defines budget as a gate, not a hard reservation.
    if (deps.budgetTotal !== null && budget.remaining() <= 0) {
      const e: WorkflowError = { kind: "BudgetExhausted", spent: budget.spent(), total: deps.budgetTotal };
      deps.emit({ type: "agent-failed", key, error: e, at: deps.now() });
      throw new WorkflowThrow(e);
    }

    // Agent cap — claim the slot synchronously so concurrent launches can't overshoot.
    if (spawned >= deps.maxAgents) {
      const e: WorkflowError = { kind: "AgentCapExceeded", cap: deps.maxAgents };
      deps.emit({ type: "agent-failed", key, error: e, at: deps.now() });
      throw new WorkflowThrow(e);
    }
    spawned++;

    let jsonSchema: Record<string, unknown> | undefined;
    if (opts.schema) {
      const converted = toJsonSchema(opts.schema);
      if (converted.isErr()) {
        const e: WorkflowError = { kind: "SchemaValidation", issues: [converted.error.kind === "Conversion" ? converted.error.cause : "conversion failed"], attempts: 0 };
        deps.emit({ type: "agent-failed", key, error: e, at: deps.now() });
        throw new WorkflowThrow(e);
      }
      jsonSchema = converted.value;
    }

    const release = await deps.semaphore.acquire();
    deps.emit({ type: "agent-started", key, at: deps.now() });
    try {
      // Signal wired for Plan 2 stop/restart; never aborted in Plan 1.
      const controller = new AbortController();
      const request: AgentRequest = {
        prompt,
        label,
        cwd: deps.cwd,
        signal: controller.signal,
        ...(jsonSchema ? { schema: jsonSchema } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.agentType ? { agentType: opts.agentType } : {}),
      };
      const result = await deps.runner.run(request, { runId: deps.runId, seq: mySeq });

      if (result.isErr()) {
        deps.emit({ type: "agent-failed", key, error: result.error, at: deps.now() });
        throw new WorkflowThrow(result.error);
      }

      const res = result.value;
      for (const tool of res.toolCalls) deps.emit({ type: "agent-tool", key, tool, at: deps.now() });

      let value: unknown = res.text;
      if (opts.schema) {
        const validated = validate(opts.schema, res.data);
        if (validated.isErr()) {
          const e: WorkflowError = { kind: "SchemaValidation", issues: validated.error.kind === "Validation" ? validated.error.issues : ["validation failed"], attempts: 1 };
          deps.emit({ type: "agent-failed", key, error: e, at: deps.now() });
          throw new WorkflowThrow(e);
        }
        value = validated.value;
      }

      budget.record(res.usage.outputTokens);
      deps.journal.record({ seq: mySeq, key, text: res.text, data: res.data, outputTokens: res.usage.outputTokens });
      deps.emit({ type: "agent-output", key, chunk: res.text, at: deps.now() });
      deps.emit({ type: "agent-finished", key, usage: res.usage, cached: false, at: deps.now() });
      return value;
    } finally {
      release();
    }
  };

  const parallel = async <T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<Array<T | null>> =>
    Promise.all(thunks.map((t) => t().catch(() => null)));

  const pipeline = async (
    items: readonly unknown[],
    ...stages: ReadonlyArray<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<Array<unknown | null>> =>
    Promise.all(
      items.map(async (item, index) => {
        let prev: unknown = item;
        try {
          for (const stage of stages) prev = await stage(prev, item, index);
          return prev;
        } catch {
          return null;
        }
      }),
    );

  const phase = (title: string): void => {
    currentPhase = title;
    deps.emit({ type: "phase-started", phase: title, at: deps.now() });
  };

  const log = (message: string): void => {
    deps.emit({ type: "log", message, at: deps.now() });
  };

  const workflow = async (name: string, childArgs?: unknown): Promise<unknown> => {
    if (!deps.resolveWorkflow) {
      throw new WorkflowThrow({ kind: "AdapterSpawn", adapter: "workflow", cause: "no workflow resolver configured" });
    }
    const loaded = await deps.resolveWorkflow(name, childArgs);
    const childRuntime: Runtime = {
      args: childArgs,
      budget,
      agent,
      parallel,
      pipeline,
      phase,
      log,
      workflow: async () => {
        throw new WorkflowThrow({ kind: "AdapterSpawn", adapter: "workflow", cause: "workflow() nesting is one level only" });
      },
    };
    return loaded.run(childRuntime, childArgs);
  };

  return { args: deps.args, budget, agent, parallel, pipeline, phase, log, workflow };
}
