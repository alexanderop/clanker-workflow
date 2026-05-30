import { z } from "zod";
import { toJsonSchema, validate } from "@workflow/schema";
import { createBudget, type Budget } from "./budget.js";
import { WorkflowThrow, type WorkflowError } from "./errors.js";
import type { Semaphore } from "./semaphore.js";
import type { Journal } from "./journal.js";
import type { AgentProgress, AgentRequest, AgentRunner, WorkflowMeta } from "./types.js";
import type { WorkflowEvent } from "./events.js";
import type { ControlRegistry } from "./control.js";

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
  readonly meta: WorkflowMeta;
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
  /** Per-call adapter dispatch: return a runner for the given adapter id, or undefined to fall back to deps.runner. */
  readonly resolveRunner?: ((id: string) => AgentRunner | undefined) | undefined;
  /** Run-scoped stop: when aborted, in-flight adapter processes are killed and new agent() calls short-circuit. */
  readonly signal?: AbortSignal | undefined;
  /** Pause gate: awaited before each agent acquires the semaphore (resolves immediately when not paused). */
  readonly gate?: (() => Promise<void>) | undefined;
  /** Per-agent control: registers each in-flight agent's AbortController under its key for stop/restart. */
  readonly control?: ControlRegistry | undefined;
  /** Worktree isolation: produce an isolated working directory for a given agent key; cleaned up after the agent finishes. */
  readonly makeIsolatedCwd?: ((key: string) => Promise<{ cwd: string; cleanup: () => Promise<void> }>) | undefined;
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

/**
 * Default agent label: the prompt's first non-empty line, truncated — so unlabeled
 * agents read like "Use the WebFetch tool (…" instead of "agent-3". The label is
 * cosmetic (the journal keys resume by seq), so deriving it can't break replay.
 */
function deriveLabel(prompt: string, seq: number): string {
  const firstLine = prompt
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine === undefined) return `agent-${seq}`;
  const max = 48;
  return firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const budget = createBudget(deps.budgetTotal);
  let currentPhase = "default";
  let seq = 0;
  let spawned = 0;

  const agent = async (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
    const mySeq = seq++;
    const phase = opts.phase ?? currentPhase;
    const label = opts.label ?? deriveLabel(prompt, mySeq);
    const key = `${mySeq}:${phase}:${label}`;

    // Live-progress sink handed to the adapter. Tool calls pass through immediately;
    // token/model updates are coalesced to ≤1/sec per agent so a long run persists
    // ~one progress line per second. Tokens are clamped monotonic (the final, real
    // usage still arrives via agent-finished).
    let lastProgressAt: number | undefined;
    let lastTokens: number | undefined;
    let lastModel: string | undefined;
    const onProgress = (p: AgentProgress): void => {
      if (p.tool) deps.emit({ type: "agent-tool", key, tool: p.tool, at: deps.now() });
      let tokens = p.tokens;
      if (tokens !== undefined) {
        if (lastTokens !== undefined && tokens < lastTokens) tokens = lastTokens;
        lastTokens = tokens;
      }
      if (p.model !== undefined) lastModel = p.model;
      if (tokens === undefined && p.model === undefined) return; // tool-only: already emitted
      const at = deps.now();
      // Coalesce token/model updates to ≤1/sec; the very first update always passes.
      if (lastProgressAt !== undefined && at - lastProgressAt < 1000) return;
      lastProgressAt = at;
      deps.emit({
        type: "agent-progress",
        key,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(p.model !== undefined ? { model: p.model } : {}),
        at,
      });
    };

    deps.emit({ type: "agent-queued", key, label, phase, prompt, at: deps.now() });

    // Run-scoped stop: a fired signal short-circuits before any work is scheduled.
    if (deps.signal?.aborted) {
      const e: WorkflowError = { kind: "AdapterSpawn", adapter: "run", cause: "run stopped" };
      deps.emit({ type: "agent-failed", key, error: e, at: deps.now() });
      throw new WorkflowThrow(e);
    }

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

    // Pause gate: hold here while paused, then re-check stop (a pause may have spanned a stop).
    if (deps.gate) await deps.gate();
    if (deps.signal?.aborted) {
      const e: WorkflowError = { kind: "AdapterSpawn", adapter: "run", cause: "run stopped" };
      deps.emit({ type: "agent-failed", key, error: e, at: deps.now() });
      throw new WorkflowThrow(e);
    }

    const release = await deps.semaphore.acquire();
    try {
      // Acquire the isolated cwd inside the try so a rejecting makeIsolatedCwd still releases
      // the semaphore slot (via the outer finally). The cwd is stable across restart iterations.
      const isolated =
        opts.isolation === "worktree" && deps.makeIsolatedCwd ? await deps.makeIsolatedCwd(key) : undefined;
      const cwd = isolated?.cwd ?? deps.cwd;
      try {
        // Restart loop: a restart request aborts the current run and re-runs with the same
        // key/seq. Restart is only meaningful while the agent is in flight (registered here).
        for (;;) {
          const controller = new AbortController();
          let restart = false;
          // Run-scoped stop and per-agent stop both drive the adapter's AbortSignal.
          const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
          const unregister = deps.control?.register(key, controller, () => {
            restart = true;
          });
          // Re-emitted each iteration: a restart is a fresh start for the same key.
          deps.emit({ type: "agent-started", key, at: deps.now() });
          try {
            const request: AgentRequest = {
              prompt,
              label,
              cwd,
              signal,
              ...(jsonSchema ? { schema: jsonSchema } : {}),
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.agentType ? { agentType: opts.agentType } : {}),
            };
            const runner = opts.adapter ? (deps.resolveRunner?.(opts.adapter) ?? deps.runner) : deps.runner;
            const result = await runner.run(request, { runId: deps.runId, seq: mySeq, onProgress });

            if (result.isErr()) {
              if (restart) continue; // restartAgent: re-run with a fresh controller, same key/seq.
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
            deps.emit({
              type: "agent-finished",
              key,
              usage: res.usage,
              cached: false,
              ...(lastModel !== undefined ? { model: lastModel } : {}),
              at: deps.now(),
            });
            return value;
          } catch (e) {
            if (restart) continue; // restart requested even on a thrown error: re-run.
            throw e; // stop / real failure: propagate (parallel nulls it).
          } finally {
            unregister?.();
          }
        }
      } finally {
        // Best-effort cleanup: a failing worktree removal must not skip release() below
        // (outer finally) nor mask the agent's real result/throw.
        if (isolated) {
          try {
            await isolated.cleanup();
          } catch {
            // ignore: leaked isolated cwd is non-fatal; the CLI factory warns on its own.
          }
        }
      }
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
