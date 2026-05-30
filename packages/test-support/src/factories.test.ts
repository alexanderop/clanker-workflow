import { describe, it, expect } from "vitest";
import { agentRequest, agentResult, event, runCtx, usage, workflowSource } from "./factories.js";

describe("factories", () => {
  it("usage/agentResult default to zero, deterministic values", () => {
    expect(usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    const r = agentResult();
    expect(r).toEqual({ text: "ok", usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: [] });
  });

  it("shallow overrides replace only the named fields", () => {
    expect(usage({ outputTokens: 9 })).toEqual({ inputTokens: 0, outputTokens: 9 });
    expect(agentResult({ text: "hi" }).text).toBe("hi");
  });

  it("event() returns the precise variant with its required fields filled", () => {
    const finished = event("agent-finished", { key: "k1", usage: usage({ outputTokens: 9 }), at: 3 });
    expect(finished).toEqual({ type: "agent-finished", key: "k1", usage: { inputTokens: 0, outputTokens: 9 }, cached: false, at: 3 });

    const log = event("log", { message: "hello" });
    expect(log).toEqual({ type: "log", message: "hello", at: 0 });
  });

  it("runCtx/agentRequest carry sensible deterministic defaults", () => {
    expect(runCtx()).toMatchObject({ runId: "r1", seq: 0 });
    const req = agentRequest({ label: "a" });
    expect(req).toMatchObject({ prompt: "p", cwd: "/tmp", label: "a" });
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it("repeated calls are independent (no shared mutable state)", () => {
    expect(event("log").at).toBe(event("log").at);
    expect(usage()).not.toBe(usage()); // fresh object each time
  });

  it("workflowSource builds a parseable legacy-meta string", () => {
    const src = workflowSource({ name: "hello", harness: "raw-api", body: "return { ok: true };" });
    expect(src).toContain(`"name":"hello"`);
    expect(src).toContain(`"harness":"raw-api"`);
    expect(src).toContain("return { ok: true };");
  });
});
