import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createRawApiAdapter,
  type CompletionRequest,
  type CompletionResult,
} from "./raw-api.js";

// Derive request/ctx types from the adapter's own signature so this test does
// not import bare "@workflow/core" types directly.
type RunFn = ReturnType<typeof createRawApiAdapter>["run"];
type AgentRequest = Parameters<RunFn>[0];
type RunCtx = Parameters<RunFn>[1];

const schema: Record<string, unknown> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: "What is 2+2?",
    cwd: "/work",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function ctx(): RunCtx {
  return { runId: "r", seq: 0 };
}

/** A `complete` fn that records its requests and returns a fixed result. */
function fakeComplete(
  result: CompletionResult,
): { complete: (r: CompletionRequest) => Promise<CompletionResult>; calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    complete: async (r) => {
      calls.push(r);
      return result;
    },
  };
}

const okResult = (data: unknown): CompletionResult => ({
  text: JSON.stringify(data),
  data,
  usage: { inputTokens: 0, outputTokens: 0 },
});

describe("raw-api adapter", () => {
  it("declares id and capabilities", () => {
    const adapter = createRawApiAdapter(fakeComplete(okResult({ answer: "4" })));
    expect(adapter.id).toBe("raw-api");
    expect(adapter.capabilities.nativeSchema).toBe(true);
    expect(adapter.capabilities.toolEvents).toBe(false);
  });

  it("forwards prompt and signal to complete()", async () => {
    const f = fakeComplete(okResult({ answer: "4" }));
    const adapter = createRawApiAdapter(f);
    const signal = new AbortController().signal;
    const res = await adapter.run(req({ signal }), ctx());
    expect(res.isOk()).toBe(true);
    expect(f.calls[0]!.prompt).toBe("What is 2+2?");
    expect(f.calls[0]!.signal).toBe(signal);
  });

  it("passes schema and model through to complete() only when present", async () => {
    const withBoth = fakeComplete(okResult({ answer: "4" }));
    await createRawApiAdapter(withBoth).run(req({ schema, model: "claude-x" }), ctx());
    expect(withBoth.calls[0]!.schema).toEqual(schema);
    expect(withBoth.calls[0]!.model).toBe("claude-x");

    const withNeither = fakeComplete(okResult({ answer: "4" }));
    await createRawApiAdapter(withNeither).run(req(), ctx());
    expect(withNeither.calls[0]!.schema).toBeUndefined();
    expect(withNeither.calls[0]!.model).toBeUndefined();
  });

  it("returns text, data and usage from the completion result", async () => {
    const adapter = createRawApiAdapter(
      fakeComplete({ text: '{"answer":"4"}', data: { answer: "4" }, usage: { inputTokens: 9, outputTokens: 6 } }),
    );
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);
    const value = res._unsafeUnwrap();
    expect(value.text).toBe('{"answer":"4"}');
    expect(value.data).toEqual({ answer: "4" });
    expect(value.usage.inputTokens).toBe(9);
    expect(value.usage.outputTokens).toBe(6);
    expect(value.toolCalls).toEqual([]);
  });

  it("omits data when the completion result has none", async () => {
    const adapter = createRawApiAdapter(
      fakeComplete({ text: "plain text answer", usage: { inputTokens: 1, outputTokens: 1 } }),
    );
    const res = await adapter.run(req(), ctx());
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().data).toBeUndefined();
  });

  it("maps a thrown Error from complete() to an AdapterSpawn error", async () => {
    const adapter = createRawApiAdapter({
      complete: async () => {
        throw new Error("network down");
      },
    });
    const res = await adapter.run(req(), ctx());
    expect(res.isErr()).toBe(true);
    const e = res._unsafeUnwrapErr();
    expect(e.kind).toBe("AdapterSpawn");
    expect(e.kind === "AdapterSpawn" && e.cause).toBe("network down");
  });

  it("maps a thrown non-Error value to an AdapterSpawn error via String()", async () => {
    const adapter = createRawApiAdapter({
      complete: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "string failure";
      },
    });
    const res = await adapter.run(req(), ctx());
    expect(res.isErr()).toBe(true);
    const e = res._unsafeUnwrapErr();
    expect(e.kind).toBe("AdapterSpawn");
    expect(e.kind === "AdapterSpawn" && e.cause).toBe("string failure");
  });

  it("round-trips arbitrary completion data through the adapter unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (answer) => {
        const adapter = createRawApiAdapter(fakeComplete(okResult({ answer })));
        const res = await adapter.run(req({ schema }), ctx());
        expect(res.isOk()).toBe(true);
        expect((res._unsafeUnwrap().data as { answer: string }).answer).toBe(answer);
      }),
      { numRuns: 20 },
    );
  });
});
