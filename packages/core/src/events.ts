import type { WorkflowError } from "./errors.js";

export interface ToolEvent {
  readonly name: string;
  readonly input?: unknown;
}

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly approximate?: boolean;
}

export type WorkflowEvent =
  | { readonly type: "run-started"; readonly runId: string; readonly name: string; readonly at: number }
  | { readonly type: "phase-started"; readonly phase: string; readonly at: number }
  | { readonly type: "agent-queued"; readonly key: string; readonly label: string; readonly phase: string; readonly prompt?: string; readonly at: number }
  | { readonly type: "agent-started"; readonly key: string; readonly at: number }
  | { readonly type: "agent-tool"; readonly key: string; readonly tool: ToolEvent; readonly at: number }
  | { readonly type: "agent-output"; readonly key: string; readonly chunk: string; readonly at: number }
  | { readonly type: "agent-finished"; readonly key: string; readonly usage: AgentUsage; readonly cached: boolean; readonly at: number }
  | { readonly type: "agent-failed"; readonly key: string; readonly error: WorkflowError; readonly at: number }
  | { readonly type: "log"; readonly message: string; readonly at: number }
  | { readonly type: "run-finished"; readonly runId: string; readonly at: number };

export type AgentStatus = "queued" | "running" | "done" | "failed";

export interface AgentState {
  readonly key: string;
  readonly label: string;
  readonly phase: string;
  readonly prompt: string;
  readonly resultText: string;
  readonly status: AgentStatus;
  readonly tokens: number;
  readonly tools: readonly ToolEvent[];
}

export interface PhaseState {
  readonly title: string;
  readonly total: number;
  readonly done: number;
  readonly running: number;
  readonly tokens: number;
}

export interface RunState {
  readonly runId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "finished";
  readonly phases: ReadonlyMap<string, PhaseState>;
  readonly agents: ReadonlyMap<string, AgentState>;
  readonly totalTokens: number;
  readonly logs: readonly string[];
}

export function initialRunState(): RunState {
  return {
    runId: "",
    name: "",
    status: "pending",
    phases: new Map(),
    agents: new Map(),
    totalTokens: 0,
    logs: [],
  };
}

function upsertPhase(
  phases: ReadonlyMap<string, PhaseState>,
  title: string,
  patch: (p: PhaseState) => PhaseState,
): Map<string, PhaseState> {
  const next = new Map(phases);
  const current = next.get(title) ?? { title, total: 0, done: 0, running: 0, tokens: 0 };
  next.set(title, patch(current));
  return next;
}

export function reduce(state: RunState, event: WorkflowEvent): RunState {
  switch (event.type) {
    case "run-started":
      return { ...state, runId: event.runId, name: event.name, status: "running" };
    case "phase-started":
      return { ...state, phases: upsertPhase(state.phases, event.phase, (p) => p) };
    case "agent-queued": {
      const agents = new Map(state.agents);
      agents.set(event.key, {
        key: event.key,
        label: event.label,
        phase: event.phase,
        prompt: event.prompt ?? "",
        resultText: "",
        status: "queued",
        tokens: 0,
        tools: [],
      });
      return {
        ...state,
        agents,
        phases: upsertPhase(state.phases, event.phase, (p) => ({ ...p, total: p.total + 1 })),
      };
    }
    case "agent-started": {
      const a = state.agents.get(event.key);
      if (!a) return state;
      const agents = new Map(state.agents);
      agents.set(event.key, { ...a, status: "running" });
      return {
        ...state,
        agents,
        phases: upsertPhase(state.phases, a.phase, (p) => ({ ...p, running: p.running + 1 })),
      };
    }
    case "agent-tool": {
      const a = state.agents.get(event.key);
      if (!a) return state;
      const agents = new Map(state.agents);
      agents.set(event.key, { ...a, tools: [...a.tools, event.tool] });
      return { ...state, agents };
    }
    case "agent-output": {
      const a = state.agents.get(event.key);
      if (!a) return state;
      const agents = new Map(state.agents);
      agents.set(event.key, { ...a, resultText: a.resultText + event.chunk });
      return { ...state, agents };
    }
    case "agent-finished": {
      const a = state.agents.get(event.key);
      if (!a) return state;
      const tokens = event.usage.inputTokens + event.usage.outputTokens;
      const agents = new Map(state.agents);
      agents.set(event.key, { ...a, status: "done", tokens });
      return {
        ...state,
        agents,
        totalTokens: state.totalTokens + tokens,
        phases: upsertPhase(state.phases, a.phase, (p) => ({
          ...p,
          done: p.done + 1,
          running: Math.max(0, p.running - (event.cached ? 0 : 1)),
          tokens: p.tokens + tokens,
        })),
      };
    }
    case "agent-failed": {
      const a = state.agents.get(event.key);
      if (!a) return state;
      const agents = new Map(state.agents);
      agents.set(event.key, { ...a, status: "failed" });
      return {
        ...state,
        agents,
        phases: upsertPhase(state.phases, a.phase, (p) => ({ ...p, running: Math.max(0, p.running - 1) })),
      };
    }
    case "log":
      return { ...state, logs: [...state.logs, event.message] };
    case "run-finished":
      return { ...state, status: "finished" };
  }
}
