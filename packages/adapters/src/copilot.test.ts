import { describe, it, expect } from "vitest";
import { createCopilotAdapter } from "./copilot.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

describe("copilot adapter", () => {
  it("injects the schema into the prompt, extracts+validates JSON, builds expected argv", async () => {
    const fake = createFakeProcessRunner({ copilot: { stdout: '```json\n{"n":7}\n```', code: 0 } });
    const adapter = createCopilotAdapter({ processRunner: fake });
    expect(adapter.capabilities.nativeSchema).toBe(false);

    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", label: "a", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res._unsafeUnwrap().data).toEqual({ n: 7 });

    const argv = fake.calls()[0]!.args;
    expect(argv).toContain("-p");
    expect(argv).toContain("--allow-all-tools");
    expect(argv).toContain("--no-ask-user");
    expect(argv).toContain("--silent");
    const promptArg = argv[argv.indexOf("-p") + 1]!;
    expect(promptArg).toMatch(/schema/i);
  });

  it("retries with feedback then errors as SchemaValidation after maxRetries", async () => {
    let n = 0;
    const fake = createFakeProcessRunner({ copilot: () => { n++; return { stdout: '{"n":"bad"}', code: 0 }; } });
    const adapter = createCopilotAdapter({ processRunner: fake, maxRetries: 2 });
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res._unsafeUnwrapErr().kind).toBe("SchemaValidation");
    expect(n).toBe(2);
  });

  it("returns AdapterSpawn (does not throw) when the CLI exits non-zero", async () => {
    const fake = createFakeProcessRunner({ copilot: { stdout: "", stderr: "boom", code: 1 } });
    const adapter = createCopilotAdapter({ processRunner: fake });
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });
});
