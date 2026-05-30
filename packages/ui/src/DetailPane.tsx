import { Box, Text } from "ink";
import type { AgentState } from "@workflow/core";
import { detailSections, isSectionHeader } from "./selectors.js";

export interface DetailPaneProps {
  readonly agent: AgentState | undefined;
  readonly scroll: number;
  readonly rows: number;
  readonly focused: boolean;
  readonly now: number;
  readonly expanded: boolean;
}

export function DetailPane({ agent, scroll, rows, focused, now, expanded }: DetailPaneProps) {
  const lines = agent ? detailSections(agent, now, expanded) : ["(no agent selected)"];
  const maxScroll = Math.max(0, lines.length - rows);
  const clamped = Math.max(0, Math.min(scroll, maxScroll));
  const visible = lines.slice(clamped, clamped + rows);
  const from = lines.length === 0 ? 0 : clamped + 1;
  const to = Math.min(lines.length, clamped + rows);
  const more = clamped < maxScroll;

  return (
    <Box flexDirection="column" flexGrow={2} borderStyle="round" borderColor={focused ? "cyan" : "gray"} paddingX={1}>
      {visible.map((line, i) => (
        <Text key={clamped + i} bold={isSectionHeader(line)} wrap="truncate-end">
          {line === "" ? " " : line}
        </Text>
      ))}
      {lines.length > rows ? (
        <Box justifyContent="flex-end">
          <Text dimColor>
            {from}–{to} of {lines.length}
            {more ? " ↓" : ""}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
