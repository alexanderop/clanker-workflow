import type { RunState, AgentState, PhaseState, WorkflowEvent } from "@workflow/core";

export function orderedPhases(state: RunState): readonly PhaseState[] {
  return [...state.phases.values()];
}

export function agentsInPhase(state: RunState, phase: string): readonly AgentState[] {
  return [...state.agents.values()].filter((a) => a.phase === phase);
}

export function detailLines(agent: AgentState): readonly string[] {
  return [
    "PROMPT",
    ...agent.prompt.split("\n"),
    "",
    "TOOL CALLS",
    ...agent.tools.map((t) => `• ${t.name}`),
    "",
    "RESULT",
    ...agent.resultText.split("\n"),
  ];
}

export function elapsedMs(events: readonly WorkflowEvent[]): number {
  if (events.length === 0) return 0;
  const start = events[0]?.at ?? 0;
  const end = events[events.length - 1]?.at ?? start;
  return Math.max(0, end - start);
}
