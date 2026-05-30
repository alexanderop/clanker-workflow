import type { AgentProgress } from "@workflow/core";

/**
 * Terminal extraction from a harness stream: the final assistant text, the
 * structured `data` when a schema was requested, real token usage, and the model.
 * Translators are pure and unit-tested against captured `.ndjson` fixtures.
 */
export interface StreamFinal {
  readonly text: string;
  readonly data?: unknown;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly model?: string;
}

/** Per-line translator: maps one native stream line to zero-or-more neutral progress signals. */
export type StreamTranslator = (line: string) => readonly AgentProgress[];

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse one NDJSON line into an object, or null for blank/garbage/non-object lines. */
export function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
