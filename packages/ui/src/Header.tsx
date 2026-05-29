import { Box, Text } from "ink";
import type { RunState } from "@workflow/core";
import { formatTokens, formatElapsed } from "./format.js";

export interface HeaderProps {
  readonly state: RunState;
  readonly elapsedMs: number;
  readonly adapter?: string | undefined;
}

export function Header({ state, elapsedMs, adapter }: HeaderProps) {
  const name = state.name || "workflow";
  const adapterSegment = adapter ? ` · adapter:${adapter}` : "";
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>
        {name} · {state.status} · {formatTokens(state.totalTokens)} tok · {formatElapsed(elapsedMs)}
        {adapterSegment}
      </Text>
    </Box>
  );
}
