import type { RunState, AgentState, PhaseState, ToolEvent, WorkflowEvent } from "@workflow/core";
import { formatTokens } from "./format.js";

export function orderedPhases(state: RunState): readonly PhaseState[] {
  return [...state.phases.values()];
}

export function agentsInPhase(state: RunState, phase: string): readonly AgentState[] {
  return [...state.agents.values()].filter((a) => a.phase === phase);
}

/** `m:ss` for ≥1min (`1:23`), bare `Ns` below a minute (`43s`) — matches the mockups. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const MODEL_NAMES: Readonly<Record<string, string>> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
  "gpt-5-codex": "GPT-5 Codex",
};

/** `claude-opus-4-8[1m]` → `Opus 4.8 (1M context)`; unknown ids fall back to the raw id. */
export function formatModel(id: string | undefined): string {
  if (!id) return "";
  const match = /^(.*?)(?:\[(\w+)\])?$/.exec(id);
  const base = match?.[1] ?? id;
  const ctx = match?.[2];
  const name = MODEL_NAMES[base] ?? base;
  return ctx ? `${name} (${ctx.toUpperCase()} context)` : name;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// Descriptive argument keys preferred for a tool preview, before falling back to
// whatever first string the input carries (e.g. WebFetch shows its prompt, not its url).
const PREFERRED_ARG_KEYS = ["prompt", "query", "description", "command", "text", "input", "path", "url"];

function firstStringArg(input: unknown): string | undefined {
  if (typeof input === "string") return input.length > 0 ? input : undefined;
  if (isRecord(input)) {
    for (const key of PREFERRED_ARG_KEYS) {
      const v = input[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return undefined;
}

const STRUCTURED_OUTPUT = new Set(["StructuredOutput", "structured_output", "structuredOutput"]);

/** `Name(firstArgPreview…)`; bare name for arg-less tools and the schema return. */
export function humanizeTool(tool: ToolEvent, maxArg = 38): string {
  if (STRUCTURED_OUTPUT.has(tool.name)) return "StructuredOutput";
  const arg = firstStringArg(tool.input);
  if (arg === undefined) return tool.name;
  const oneLine = arg.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > maxArg ? `${oneLine.slice(0, maxArg)}…` : oneLine;
  return `${tool.name}(${preview})`;
}

export interface ActivityDigest {
  readonly shown: readonly string[];
  readonly total: number;
}

/** The last `k` humanized tool calls plus the total count ("last 3 of 6"). */
export function activityDigest(agent: AgentState, k = 3): ActivityDigest {
  const tools = agent.tools;
  const shown = tools.slice(Math.max(0, tools.length - k)).map((t) => humanizeTool(t));
  return { shown, total: tools.length };
}

/** Wall-clock elapsed for an agent: `now − startedAt` while running, frozen at `endedAt` once done. */
export function agentElapsedMs(agent: AgentState, now: number): number {
  if (agent.startedAt === undefined) return 0;
  const end = agent.endedAt ?? now;
  return Math.max(0, end - agent.startedAt);
}

/** Wall-clock elapsed for the whole run, frozen at `endedAt` once finished. */
export function runElapsedMs(state: RunState, now: number): number {
  if (state.startedAt === undefined) return 0;
  const end = state.endedAt ?? now;
  return Math.max(0, end - state.startedAt);
}

function liveTokenCount(agent: AgentState): number {
  return agent.status === "running" ? (agent.liveTokens ?? agent.tokens) : agent.tokens;
}

export interface AgentRow {
  readonly status: AgentState["status"];
  readonly label: string;
  readonly model: string;
  readonly tokens: string;
  readonly toolCount: number;
  readonly elapsed: string;
}

/** Glanceable per-agent row datum for the AGENTS column (icon chosen by the component). */
export function agentRow(agent: AgentState, now: number): AgentRow {
  return {
    status: agent.status,
    label: agent.label,
    model: formatModel(agent.model),
    tokens: formatTokens(liveTokenCount(agent)),
    toolCount: agent.tools.length,
    elapsed: formatDuration(agentElapsedMs(agent, now)),
  };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Flat `string[]` for the scrollable detail pane: Status, Metrics, Prompt (collapsed
 * unless `expanded`), Activity (digested), Outcome. Section headers carry no indent;
 * body lines are indented two spaces so the component can style headers distinctly.
 */
export function detailSections(agent: AgentState, now: number, expanded = false): readonly string[] {
  const lines: string[] = [];

  const statusWord =
    agent.status === "done" ? "Completed" : agent.status === "failed" ? "Failed" : agent.status === "running" ? "Running" : "Queued";
  const glyph = agent.status === "done" ? "✓" : agent.status === "failed" ? "✗" : "·";
  const model = agent.model ? ` · ${formatModel(agent.model)}` : "";
  lines.push(`${glyph} ${statusWord}${model}`);
  lines.push(`${formatTokens(liveTokenCount(agent))} tok · ${plural(agent.tools.length, "tool call")} · ${formatDuration(agentElapsedMs(agent, now))}`);
  lines.push("");

  const promptLines = agent.prompt.length > 0 ? agent.prompt.split("\n") : [];
  if (expanded) {
    lines.push(`Prompt · ${plural(promptLines.length, "line")} · ⏎ collapse`);
    for (const l of promptLines) lines.push(`  ${l}`);
  } else {
    const head = promptLines.slice(0, 2);
    const more = Math.max(0, promptLines.length - 2);
    lines.push(`Prompt · ${plural(promptLines.length, "line")} · ⏎ expand`);
    for (const l of head) lines.push(`  ${l}`);
    if (more > 0) lines.push(`  … ${more} more line${more === 1 ? "" : "s"}`);
  }
  lines.push("");

  const digest = activityDigest(agent, 3);
  if (digest.total > digest.shown.length) lines.push(`Activity · last ${digest.shown.length} of ${digest.total} tool calls`);
  else if (digest.total > 0) lines.push(`Activity · ${plural(digest.total, "tool call")}`);
  else lines.push("Activity · none yet");
  for (const t of digest.shown) lines.push(`  ${t}`);
  lines.push("");

  lines.push("Outcome");
  if (agent.resultText.length > 0) for (const l of agent.resultText.split("\n")) lines.push(`  ${l}`);
  else lines.push("  (pending)");

  return lines;
}

/** Section-header lines (no leading indent) so the pane can bold them. */
export function isSectionHeader(line: string): boolean {
  return /^(✓|✗|·) /.test(line) || /^(Prompt|Activity|Outcome)\b/.test(line);
}

export function elapsedMs(events: readonly WorkflowEvent[]): number {
  if (events.length === 0) return 0;
  const start = events[0]?.at ?? 0;
  const end = events[events.length - 1]?.at ?? start;
  return Math.max(0, end - start);
}
