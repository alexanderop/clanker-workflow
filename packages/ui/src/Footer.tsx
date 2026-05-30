import { Box, Text } from "ink";
import type { FocusColumn } from "./navigation.js";

export interface FooterProps {
  readonly focus: FocusColumn;
}

/** Contextual key hints: list levels vs. the drilled-in detail pane. */
export function Footer({ focus }: FooterProps) {
  const keys =
    focus === "detail"
      ? "↑↓ agent · j/k scroll · ⏎ prompt · p pause · esc back · s save"
      : "↑↓ select · ⏎ open · esc back · s save";
  return (
    <Box paddingX={1}>
      <Text dimColor>{keys}</Text>
    </Box>
  );
}
