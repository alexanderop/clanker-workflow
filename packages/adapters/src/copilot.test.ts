import { describe, it, expect } from "vitest";
import type { AgentProgress } from "@workflow/core";
import { createCopilotAdapter } from "./copilot.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

// Mirrors the real `copilot --output-format json` shape: payloads nested under
// `data`, answer text + tokens in `assistant.message`, and a text/token-free
// terminal `result` event.
const resultStream = (resultText: string): string =>
  `{"type":"session.tools_updated","data":{"model":"claude-sonnet-4-6"}}\n` +
  `{"type":"assistant.message","data":{"model":"claude-sonnet-4-6","content":${JSON.stringify(resultText)},"outputTokens":42}}\n` +
  `{"type":"result","exitCode":0,"usage":{"premiumRequests":1}}`;

describe("copilot adapter", () => {
  it("injects the schema into the prompt, extracts+validates JSON from the json stream, builds expected argv", async () => {
    const fake = createFakeProcessRunner({ copilot: { stdout: resultStream('{"n":7}'), code: 0 } });
    const adapter = createCopilotAdapter({ processRunner: fake });
    expect(adapter.capabilities.nativeSchema).toBe(false);
    expect(adapter.capabilities.reportsTokens).toBe(true);

    const progress: AgentProgress[] = [];
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", label: "a", signal: new AbortController().signal },
      { runId: "r", seq: 0, onProgress: (p) => progress.push(p) },
    );
    expect(res._unsafeUnwrap().data).toEqual({ n: 7 });
    expect(res._unsafeUnwrap().usage.outputTokens).toBe(42);
    expect(progress.find((p) => p.model)?.model).toBe("claude-sonnet-4-6");

    const argv = fake.calls()[0]!.args;
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--allow-all-tools");
    expect(argv).toContain("--no-ask-user");
    expect(argv).toContain("--silent");
    const promptArg = argv[argv.indexOf("-p") + 1]!;
    expect(promptArg).toMatch(/schema/i);
  });

  it("retries with feedback then errors as SchemaValidation after maxRetries", async () => {
    let n = 0;
    const fake = createFakeProcessRunner({ copilot: () => { n++; return { stdout: resultStream('{"n":"bad"}'), code: 0 }; } });
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
