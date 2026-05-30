import { Box, Text } from "ink";
import type { RunState } from "@workflow/core";
import { formatDuration } from "./selectors.js";

export interface HeaderProps {
  readonly state: RunState;
  /** Run-elapsed in ms (now − startedAt while running, frozen at endedAt once done). */
  readonly elapsedMs: number;
  readonly adapter?: string | undefined;
}

/** Count finished agents across all phases for the `X/Y agents` summary. */
function agentCounts(state: RunState): { done: number; total: number } {
  let done = 0;
  for (const a of state.agents.values()) if (a.status === "done") done++;
  return { done, total: state.agents.size };
}

export function Header({ state, elapsedMs, adapter }: HeaderProps) {
  const name = state.name || "workflow";
  const { done, total } = agentCounts(state);
  const statusWord = state.status === "finished" ? "done" : state.status === "running" ? "running" : "pending";
  const noun = total === 1 ? "agent" : "agents";
  const adapterSegment = adapter ? ` · ${adapter}` : "";
  const summary = `${done}/${total} ${noun} · ${formatDuration(elapsedMs)} · ${statusWord}${adapterSegment}`;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{name}</Text>
        <Text dimColor>{summary}</Text>
      </Box>
      {state.description ? <Text dimColor wrap="truncate-end">{state.description}</Text> : null}
    </Box>
  );
}
