import { assertNever, createControlRegistry, initialRunState, reduce, selectRunReport } from "@workflow/core";
import type { AgentRunner, JournalEntry, RunReportStatus, WorkflowEvent } from "@workflow/core";
import { renderReportText } from "@workflow/ui";
import type { AppDeps } from "./app.js";
import { buildRunnerMap } from "./adapter-select.js";
import { effectiveConcurrency, effectiveMaxAgents } from "./config.js";
import { runWorkflow, type RunResult } from "./orchestrator.js";
import type { RunStatus } from "./registry.js";
import { formatError } from "./format-error.js";
import { buildArtifacts, resolveOutputDir, writeArtifacts } from "./artifacts.js";
import { buildWorkflowResolver } from "./resolve-workflow.js";
import { createWorktreeFactory } from "./worktree.js";

/** Capability slice the foreground/headless run loops need. */
type RunDeps = Pick<AppDeps, "registry" | "config" | "clock" | "env" | "io" | "adapters" | "ui">;

export interface ExecuteParams {
  readonly runId: string;
  readonly source: string;
  readonly args: unknown;
  readonly runner: AgentRunner;
  readonly adapter: string;
  readonly seed: readonly JournalEntry[];
  /** When set, per-call `agent({ adapter })` overrides also resolve to `runner` (the mock), so a --mock run spawns no real adapter. */
  readonly mock?: boolean;
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

/**
 * Surface a finished run's return value. The object is always printed to the terminal;
 * when the workflow declared `meta.output`, it is also persisted there (`result.json`
 * verbatim plus each top-level string field as its own file).
 */
function emitArtifacts(deps: Pick<AppDeps, "ui" | "env" | "io">, run: RunResult): void {
  const set = buildArtifacts(run.returnValue);
  if (!set) return;
  deps.ui.print(`\n${set.terminal}\n`);
  const dir = resolveOutputDir(run.output, deps.env.cwd);
  if (dir) {
    const names = writeArtifacts(set, dir, deps.io.writeText);
    deps.ui.print(`\nartifacts → ${dir} (${names.join(", ")})\n`);
  }
}

/** Map a persisted run status to the report's coarser run status. */
function reportStatus(status: RunStatus): RunReportStatus {
  return status === "finished" ? "finished" : "failed";
}

/** Print the end-of-run report, projected from the persisted event stream. */
function printReport(deps: Pick<AppDeps, "registry" | "ui">, runId: string, status: RunStatus): void {
  const state = deps.registry.readEvents(runId).reduce(reduce, initialRunState());
  const report = selectRunReport(state, { status: reportStatus(status) });
  deps.ui.print(`\n${renderReportText(report)}\n`);
}

/** Run with the live Ink UI attached (run + resume foreground). Returns a process exit code. */
export async function runForeground(deps: RunDeps, params: ExecuteParams): Promise<number> {
  const controller = new AbortController();
  const control = createControlRegistry();
  const { gate, toggle } = createGate();
  const listeners = new Set<(e: WorkflowEvent) => void>();

  const emit = (event: WorkflowEvent): void => {
    deps.registry.appendEvent(params.runId, event);
    for (const l of listeners) l(event);
  };
  const note = (message: string): void => emit({ type: "log", message, at: deps.clock.now() });

  const ui = deps.ui.start({
    initial: deps.registry.readEvents(params.runId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    adapter: params.adapter,
    isTTY: deps.env.isTTY,
    write: deps.ui.print,
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
        default:
          assertNever(action);
      }
    },
  });

  // In --mock mode every per-call adapter override resolves to the mock runner too,
  // so no real harness is ever dispatched; otherwise build the real per-call adapter map.
  const resolveRunner = params.mock
    ? () => params.runner
    : buildRunnerMap(deps.adapters.detected, deps.config, { processRunner: deps.adapters.processRunner, complete: deps.adapters.complete }).resolveRunner;
  const makeIsolatedCwd = createWorktreeFactory({ processRunner: deps.adapters.processRunner, baseCwd: deps.env.cwd, tmpRoot: deps.env.tmpDir, runId: params.runId, warn: note });

  const result = await runWorkflow({
    source: params.source,
    args: params.args,
    runner: params.runner,
    runId: params.runId,
    cwd: deps.env.cwd,
    concurrency: effectiveConcurrency(deps.config, deps.env.cores),
    maxAgents: effectiveMaxAgents(deps.config),
    budgetTotal: deps.config.budget ?? null,
    journal: deps.registry.persistentJournal(params.runId, params.seed),
    emit,
    now: deps.clock.now,
    signal: controller.signal,
    control,
    gate,
    resolveWorkflow: buildWorkflowResolver({ homeDir: deps.env.homeDir, cwd: deps.env.cwd, readTextFile: deps.io.readText, bundledDir: deps.env.bundledDir }),
    resolveRunner,
    makeIsolatedCwd,
  });

  const status: RunStatus = controller.signal.aborted ? "stopped" : result.isOk() ? "finished" : "failed";
  deps.registry.updateMeta(params.runId, { status, endedAt: deps.clock.now() });
  ui.unmount();

  if (result.isErr()) {
    deps.ui.print(`run ${status}: ${formatError(result.error)}\n`);
    printReport(deps, params.runId, status);
    return 1;
  }
  emitArtifacts(deps, result.value);
  printReport(deps, params.runId, status);
  return 0;
}

/** Run headless (the detached child body). Returns a process exit code. */
export async function runHeadless(deps: RunDeps, params: ExecuteParams, controller: AbortController): Promise<number> {
  const { resolveRunner } = buildRunnerMap(deps.adapters.detected, deps.config, { processRunner: deps.adapters.processRunner, complete: deps.adapters.complete });
  const makeIsolatedCwd = createWorktreeFactory({
    processRunner: deps.adapters.processRunner,
    baseCwd: deps.env.cwd,
    tmpRoot: deps.env.tmpDir,
    runId: params.runId,
    warn: (message) => deps.registry.appendEvent(params.runId, { type: "log", message, at: deps.clock.now() }),
  });

  const result = await runWorkflow({
    source: params.source,
    args: params.args,
    runner: params.runner,
    runId: params.runId,
    cwd: deps.env.cwd,
    concurrency: effectiveConcurrency(deps.config, deps.env.cores),
    maxAgents: effectiveMaxAgents(deps.config),
    budgetTotal: deps.config.budget ?? null,
    journal: deps.registry.persistentJournal(params.runId, params.seed),
    emit: (event) => deps.registry.appendEvent(params.runId, event),
    now: deps.clock.now,
    signal: controller.signal,
    resolveWorkflow: buildWorkflowResolver({ homeDir: deps.env.homeDir, cwd: deps.env.cwd, readTextFile: deps.io.readText, bundledDir: deps.env.bundledDir }),
    resolveRunner,
    makeIsolatedCwd,
  });

  const status: RunStatus = controller.signal.aborted ? "stopped" : result.isOk() ? "finished" : "failed";
  deps.registry.updateMeta(params.runId, { status, endedAt: deps.clock.now() });
  if (result.isErr()) return 1;
  emitArtifacts(deps, result.value);
  return 0;
}

/** Persist a run's script snapshot as a saved workflow (project `.workflow` if present, else personal). */
export function saveRun(deps: Pick<AppDeps, "registry" | "env" | "io">, runId: string): string | undefined {
  const meta = deps.registry.readMeta(runId);
  const source = deps.registry.readScript(runId);
  if (!meta || source === undefined) return undefined;
  const projectDir = `${deps.env.cwd}/.workflow`;
  const base = deps.io.readText(`${projectDir}/config.json`) !== undefined ? projectDir : `${deps.env.homeDir}/.workflow`;
  const path = `${base}/workflows/${meta.name}.ts`;
  deps.io.writeText(path, source);
  return path;
}
