import { describe, it, expect } from "vitest";
import { createGenericAdapter } from "./generic.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

describe("generic adapter", () => {
  it("passes the prompt via stdin and parses extracted JSON when schema=prompt-inject", async () => {
    const fake = createFakeProcessRunner({ gemini: { stdout: 'result: {"n":7}', code: 0 } });
    const adapter = createGenericAdapter(
      { id: "gemini", command: "gemini", promptArg: "stdin", args: ["-o", "json"], schema: "prompt-inject" },
      { processRunner: fake },
    );
    expect(adapter.id).toBe("gemini");
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res._unsafeUnwrap().data).toEqual({ n: 7 });
    expect(fake.calls()[0]!.stdin).toMatch(/give n/);
    expect(fake.calls()[0]!.args).toEqual(["-o", "json"]);
  });

  it("passes the prompt as the last positional arg when promptArg=last", async () => {
    const fake = createFakeProcessRunner({ aider: { stdout: "ok", code: 0 } });
    const adapter = createGenericAdapter({ id: "aider", command: "aider", promptArg: "last", schema: "none" }, { processRunner: fake });
    await adapter.run({ prompt: "hello", cwd: "/tmp", signal: new AbortController().signal }, { runId: "r", seq: 0 });
    const argv = fake.calls()[0]!.args;
    expect(argv[argv.length - 1]).toBe("hello");
  });

  it("returns AdapterSpawn (does not throw) when the CLI exits non-zero", async () => {
    const fake = createFakeProcessRunner({ tool: { stdout: "", stderr: "boom", code: 1 } });
    const adapter = createGenericAdapter({ id: "tool", command: "tool", promptArg: "last", schema: "prompt-inject" }, { processRunner: fake });
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });
});
