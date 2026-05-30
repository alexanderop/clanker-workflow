import { createControlRegistry } from "@workflow/core";
import type { AgentRunner, JournalEntry, WorkflowEvent } from "@workflow/core";
import type { AppDeps } from "./app.js";
import { buildRunnerMap } from "./adapter-select.js";
import { effectiveConcurrency, effectiveMaxAgents } from "./config.js";
import { runWorkflow } from "./orchestrator.js";
import type { RunStatus } from "./registry.js";
import { formatError } from "./format-error.js";
import { buildWorkflowResolver } from "./resolve-workflow.js";
import { createWorktreeFactory } from "./worktree.js";

export interface ExecuteParams {
  readonly runId: string;
  readonly source: string;
  readonly args: unknown;
  readonly runner: AgentRunner;
  readonly adapter: string;
  readonly seed: readonly JournalEntry[];
}

/** A simple pause gate: agents hold while paused, released on resume. */
function createGate(): { gate: () => Promise<void>; toggle: () => boolean } {
  let paused = false;
  let waiters: Array<() => void> = [];
  return {
    gate: () => (paused ? new Promise<void>((res) => waiters.push(res)) : Promise.resolve()),
    toggle: () => {
      paused = !paused;
      if (!paused) {
        const pending = waiters;
        waiters = [];
        for (const w of pending) w();
      }
      return paused;
    },
  };
}

/** Run with the live Ink UI attached (run + resume foreground). Returns a process exit code. */
export async function runForeground(deps: AppDeps, params: ExecuteParams): Promise<number> {
  const controller = new AbortController();
  const control = createControlRegistry();
  const { gate, toggle } = createGate();
  const listeners = new Set<(e: WorkflowEvent) => void>();

  const emit = (event: WorkflowEvent): void => {
    deps.registry.appendEvent(params.runId, event);
    for (const l of listeners) l(event);
  };
  const note = (message: string): void => emit({ type: "log", message, at: deps.now() });

  const ui = deps.startUi({
    initial: deps.registry.readEvents(params.runId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    adapter: params.adapter,
    isTTY: deps.isTTY,
    write: deps.print,
    onAction: (action) => {
      switch (action.type) {
        case "pause":
          note(toggle() ? "paused" : "resumed");
          break;
        case "stop":
          if (action.target.scope === "run") controller.abort();
          else control.stopAgent(action.target.key);
          break;
        case "restart":
          control.restartAgent(action.key);
          break;
        case "save":
          saveRun(deps, params.runId);
          note("saved workflow script");
          break;
      }
    },
  });

  const { resolveRunner } = buildRunnerMap(deps.detected, deps.config, { processRunner: deps.processRunner, complete: deps.complete });
  const makeIsolatedCwd = createWorktreeFactory({ processRunner: deps.processRunner, baseCwd: deps.cwd, tmpRoot: deps.tmpDir, runId: params.runId, warn: note });

  const result = await runWorkflow({
    source: params.source,
    args: params.args,
    runner: params.runner,
    runId: params.runId,
    cwd: deps.cwd,
    concurrency: effectiveConcurrency(deps.config, deps.cores),
    maxAgents: effectiveMaxAgents(deps.config),
    budgetTotal: deps.config.budget ?? null,
    journal: deps.registry.persistentJournal(params.runId, params.seed),
    emit,
    now: deps.now,
    signal: controller.signal,
    control,
    gate,
    resolveWorkflow: buildWorkflowResolver({ homeDir: deps.homeDir, cwd: deps.cwd, readTextFile: deps.readTextFile }),
    resolveRunner,
    makeIsolatedCwd,
  });

  const status: RunStatus = controller.signal.aborted ? "stopped" : result.isOk() ? "finished" : "failed";
  deps.registry.updateMeta(params.runId, { status, endedAt: deps.now() });
  ui.unmount();

  if (result.isErr()) {
    deps.print(`run ${status}: ${formatError(result.error)}\n`);
    return 1;
  }
  return 0;
}

/** Run headless (the detached child body). Returns a process exit code. */
export async function runHeadless(deps: AppDeps, params: ExecuteParams, controller: AbortController): Promise<number> {
  const { resolveRunner } = buildRunnerMap(deps.detected, deps.config, { processRunner: deps.processRunner, complete: deps.complete });
  const makeIsolatedCwd = createWorktreeFactory({
    processRunner: deps.processRunner,
    baseCwd: deps.cwd,
    tmpRoot: deps.tmpDir,
    runId: params.runId,
    warn: (message) => deps.registry.appendEvent(params.runId, { type: "log", message, at: deps.now() }),
  });

  const result = await runWorkflow({
    source: params.source,
    args: params.args,
    runner: params.runner,
    runId: params.runId,
    cwd: deps.cwd,
    concurrency: effectiveConcurrency(deps.config, deps.cores),
    maxAgents: effectiveMaxAgents(deps.config),
    budgetTotal: deps.config.budget ?? null,
    journal: deps.registry.persistentJournal(params.runId, params.seed),
    emit: (event) => deps.registry.appendEvent(params.runId, event),
    now: deps.now,
    signal: controller.signal,
    resolveWorkflow: buildWorkflowResolver({ homeDir: deps.homeDir, cwd: deps.cwd, readTextFile: deps.readTextFile }),
    resolveRunner,
    makeIsolatedCwd,
  });

  const status: RunStatus = controller.signal.aborted ? "stopped" : result.isOk() ? "finished" : "failed";
  deps.registry.updateMeta(params.runId, { status, endedAt: deps.now() });
  return result.isErr() ? 1 : 0;
}

/** Persist a run's script snapshot as a saved workflow (project `.workflow` if present, else personal). */
export function saveRun(deps: AppDeps, runId: string): string | undefined {
  const meta = deps.registry.readMeta(runId);
  const source = deps.registry.readScript(runId);
  if (!meta || source === undefined) return undefined;
  const projectDir = `${deps.cwd}/.workflow`;
  const base = deps.readTextFile(`${projectDir}/config.json`) !== undefined ? projectDir : `${deps.homeDir}/.workflow`;
  const path = `${base}/workflows/${meta.name}.ts`;
  deps.writeTextFile(path, source);
  return path;
}
