import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { AgentProgress } from "@workflow/core";
import { createCopilotAdapter } from "./copilot.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

const stream = readFileSync(new URL("../fixtures/copilot-stream.ndjson", import.meta.url), "utf8");

const resultStream = (text: string): string =>
  `{"type":"session.created","session_id":"s","model":"m"}\n${JSON.stringify({ type: "result", text })}\n`;

describe("copilot adapter", () => {
  it("streams json, extracts+validates the result text, and forwards progress", async () => {
    const fake = createFakeProcessRunner({ copilot: { stdout: stream, code: 0 } });
    const adapter = createCopilotAdapter({ processRunner: fake });
    expect(adapter.capabilities.nativeSchema).toBe(false);
    expect(adapter.capabilities.reportsTokens).toBe(true);

    const progress: AgentProgress[] = [];
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", label: "a", signal: new AbortController().signal },
      { runId: "r", seq: 0, onProgress: (p) => progress.push(p) },
    );
    expect(res._unsafeUnwrap().data).toEqual({ n: 7 });
    expect(res._unsafeUnwrap().usage.outputTokens).toBe(30);

    expect(progress.find((p) => p.model)?.model).toBe("claude-sonnet-4-6");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["shell"]);

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
