import type {
  AgentRequest,
  AgentResult,
  AgentUsage,
  RunCtx,
  ToolEvent,
  WorkflowEvent,
} from "@workflow/core";

/**
 * Deterministic test-data factories: fixed defaults + a shallow `Partial` override.
 *
 * Determinism is deliberate — this engine's journal replay bans `Math.random()`/`Date.now()`,
 * so factories NEVER randomize. Defaults are fixed constants (`at: 0`, `outputTokens: 0`); a
 * test that needs variation passes it explicitly. There is no shared mutable counter here: that
 * would leak state across tests and reintroduce order-dependence. For generative coverage use
 * `fast-check` (seeded, shrinking), not random data.
 */

export const usage = (o: Partial<AgentUsage> = {}): AgentUsage => ({ inputTokens: 0, outputTokens: 0, ...o });

export const toolEvent = (o: Partial<ToolEvent> = {}): ToolEvent => ({ name: "tool", ...o });

export const agentResult = (o: Partial<AgentResult> = {}): AgentResult => ({
  text: "ok",
  usage: usage(),
  toolCalls: [],
  ...o,
});

export const runCtx = (o: Partial<RunCtx> = {}): RunCtx => ({ runId: "r1", seq: 0, ...o });

export const agentRequest = (o: Partial<AgentRequest> = {}): AgentRequest => ({
  prompt: "p",
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...o,
});

type EventOf<T extends WorkflowEvent["type"]> = Extract<WorkflowEvent, { type: T }>;

/** Per-variant base (every required field except the `type` discriminant). */
const EVENT_BASES: { [T in WorkflowEvent["type"]]: Omit<EventOf<T>, "type"> } = {
  "run-started": { runId: "r1", name: "wf", at: 0 },
  "phase-started": { phase: "Work", at: 0 },
  "agent-queued": { key: "0:Work:a", label: "a", phase: "Work", at: 0 },
  "agent-started": { key: "0:Work:a", at: 0 },
  "agent-tool": { key: "0:Work:a", tool: { name: "tool" }, at: 0 },
  "agent-progress": { key: "0:Work:a", at: 0 },
  "agent-output": { key: "0:Work:a", chunk: "", at: 0 },
  "agent-finished": { key: "0:Work:a", usage: { inputTokens: 0, outputTokens: 0 }, cached: false, at: 0 },
  "agent-failed": { key: "0:Work:a", error: { kind: "AdapterSpawn", adapter: "test", cause: "boom" }, at: 0 },
  log: { message: "log", at: 0 },
  "run-finished": { runId: "r1", at: 0 },
};

/**
 * Build a `WorkflowEvent` of a given variant. Returns the precise member type, so `overrides`
 * are checked against that variant's fields:
 *   event("agent-finished", { usage: usage({ outputTokens: 9 }), at: 3 })
 */
export function event<T extends WorkflowEvent["type"]>(type: T, overrides: Partial<EventOf<T>> = {}): EventOf<T> {
  return { type, ...EVENT_BASES[type], ...overrides } as unknown as EventOf<T>;
}

export interface WorkflowSourceOpts {
  readonly name?: string;
  readonly description?: string;
  readonly harness?: string;
  readonly phases?: ReadonlyArray<{ title: string }>;
  /** The workflow body after the `meta` line. Defaults to a single labelled agent call. */
  readonly body?: string;
}

/** Build a legacy-`meta` workflow source string for sandbox/loader/dispatch tests. */
export function workflowSource(o: WorkflowSourceOpts = {}): string {
  const meta = {
    name: o.name ?? "wf",
    description: o.description ?? "d",
    ...(o.harness ? { harness: o.harness } : {}),
    ...(o.phases ? { phases: o.phases } : {}),
  };
  const body = o.body ?? `const r = await agent("go", { label: "a" });\nreturn { r };`;
  return `export const meta = ${JSON.stringify(meta)} as const\n${body}`;
}
