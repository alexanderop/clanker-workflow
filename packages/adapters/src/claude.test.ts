import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createClaudeAdapter } from "./claude.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

// Derive request/ctx types from the adapter's own `run` signature so this test
// does not import bare "@workflow/core" types directly.
type RunFn = ReturnType<typeof createClaudeAdapter>["run"];
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

// The claude CLI uses --output-format stream-json. The translator turns a
// terminal `result` event (with `is_error`/`result`/`usage`/`structured_output`)
// into the final AgentResult.
function resultEvent(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", ...fields });
}

describe("claude adapter", () => {
  it("declares id and capabilities", () => {
    const fake = createFakeProcessRunner({ claude: { stdout: "", code: 0 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    expect(adapter.id).toBe("claude");
    expect(adapter.capabilities.nativeSchema).toBe(true);
  });

  it("passes --json-schema with the serialized schema and builds the expected argv", async () => {
    const fake = createFakeProcessRunner({
      claude: { stdout: resultEvent({ structured_output: { answer: "4" }, result: '{"answer":"4"}' }), code: 0 },
    });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);

    const argv = fake.calls()[0]!.args;
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--dangerously-skip-permissions");
    const i = argv.indexOf("--json-schema");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe(JSON.stringify(schema));
  });

  it("does not append --json-schema when no schema is given", async () => {
    const fake = createFakeProcessRunner({ claude: { stdout: resultEvent({ result: "hello" }), code: 0 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(req(), ctx());
    expect(res.isOk()).toBe(true);
    expect(fake.calls()[0]!.args).not.toContain("--json-schema");
  });

  it("appends --model only when req.model is set", async () => {
    const fakeNo = createFakeProcessRunner({ claude: { stdout: resultEvent({ result: "x" }), code: 0 } });
    await createClaudeAdapter({ processRunner: fakeNo }).run(req(), ctx());
    expect(fakeNo.calls()[0]!.args).not.toContain("--model");

    const fakeYes = createFakeProcessRunner({ claude: { stdout: resultEvent({ result: "x" }), code: 0 } });
    await createClaudeAdapter({ processRunner: fakeYes }).run(req({ model: "opus" }), ctx());
    const argv = fakeYes.calls()[0]!.args;
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  });

  it("returns validated structured output and usage on success", async () => {
    const fake = createFakeProcessRunner({
      claude: {
        stdout: resultEvent({
          structured_output: { answer: "4" },
          result: '{"answer":"4"}',
          usage: { input_tokens: 11, output_tokens: 7 },
        }),
        code: 0,
      },
    });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);
    const value = res._unsafeUnwrap();
    expect(value.data).toEqual({ answer: "4" });
    expect(value.usage.inputTokens).toBe(11);
    expect(value.usage.outputTokens).toBe(7);
  });

  it("falls back to extractJson from result text when structured_output is absent", async () => {
    const fake = createFakeProcessRunner({
      claude: { stdout: resultEvent({ result: 'Here you go: {"answer":"4"}' }), code: 0 },
    });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().data).toEqual({ answer: "4" });
  });

  it("returns AdapterSpawn when the CLI exits non-zero", async () => {
    const fake = createFakeProcessRunner({ claude: { stdout: "", stderr: "boom", code: 1 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isErr()).toBe(true);
    const e = res._unsafeUnwrapErr();
    expect(e.kind).toBe("AdapterSpawn");
    expect(e.kind === "AdapterSpawn" && e.cause).toContain("boom");
  });

  it("returns AdapterSpawn when the stream reports is_error", async () => {
    const fake = createFakeProcessRunner({
      claude: { stdout: resultEvent({ is_error: true, result: "model failed" }), code: 0 },
    });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });

  it("returns SchemaValidation after retries when output violates the schema", async () => {
    const fake = createFakeProcessRunner({
      claude: { stdout: resultEvent({ structured_output: { answer: 42 }, result: '{"answer":42}' }), code: 0 },
    });
    const adapter = createClaudeAdapter({ processRunner: fake, maxRetries: 2 });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("SchemaValidation");
  });

  it("returns SchemaValidation when the result text has no JSON at all", async () => {
    const fake = createFakeProcessRunner({
      claude: { stdout: resultEvent({ result: "no json here, just prose" }), code: 0 },
    });
    const adapter = createClaudeAdapter({ processRunner: fake, maxRetries: 1 });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("SchemaValidation");
  });

  it("forwards translated progress events to ctx.onProgress", async () => {
    const fake = createFakeProcessRunner({
      claude: {
        stdout:
          JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6" }) +
          "\n" +
          resultEvent({ structured_output: { answer: "4" }, result: '{"answer":"4"}' }),
        code: 0,
      },
    });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const progress: unknown[] = [];
    await adapter.run(req({ schema }), { runId: "r", seq: 0, onProgress: (p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(0);
  });

  it("round-trips arbitrary valid answer values through structured_output", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (answer) => {
        const fake = createFakeProcessRunner({
          claude: {
            stdout: resultEvent({ structured_output: { answer }, result: JSON.stringify({ answer }) }),
            code: 0,
          },
        });
        const adapter = createClaudeAdapter({ processRunner: fake });
        const res = await adapter.run(req({ schema }), ctx());
        expect(res.isOk()).toBe(true);
        expect((res._unsafeUnwrap().data as { answer: string }).answer).toBe(answer);
      }),
      { numRuns: 20 },
    );
  });
});
