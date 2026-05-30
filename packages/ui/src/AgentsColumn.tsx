import { Box, Text } from "ink";
import type { AgentState } from "@workflow/core";
import { statusGlyph } from "./format.js";
import { agentRow } from "./selectors.js";

export interface AgentsColumnProps {
  readonly agents: readonly AgentState[];
  readonly selectedIndex: number;
  readonly focused: boolean;
  readonly phaseTitle: string;
  readonly frame: number;
  /** Wall-clock now (ms) for live elapsed; injected so the column stays pure. */
  readonly now: number;
  readonly maxVisible?: number;
}

export function AgentsColumn({ agents, selectedIndex, focused, phaseTitle, frame, now, maxVisible = 10 }: AgentsColumnProps) {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, agents.length - maxVisible)));
  const visible = agents.slice(start, start + maxVisible);
  const title = phaseTitle ? `${phaseTitle} · ${agents.length} ${agents.length === 1 ? "agent" : "agents"}` : "Agents";

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      <Text bold>{title}</Text>
      {agents.length === 0 ? <Text dimColor>not started yet</Text> : null}
      {visible.map((a, i) => {
        const index = start + i;
        const row = agentRow(a, now);
        const metrics =
          a.status === "queued"
            ? "queued"
            : `${row.tokens} tok · ${row.toolCount} ${row.toolCount === 1 ? "tool" : "tools"}${a.endedAt !== undefined ? ` · ${row.elapsed}` : ""}`;
        return (
          <Box key={a.key} justifyContent="space-between">
            <Text inverse={index === selectedIndex} wrap="truncate-end">
              {statusGlyph(a.status, frame)} {row.label}
              {row.model ? <Text dimColor> {row.model}</Text> : null}
            </Text>
            <Text dimColor> {metrics}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
