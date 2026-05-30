import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { AgentProgress } from "@workflow/core";
import { createClaudeAdapter } from "./claude.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

const stream = readFileSync(new URL("../fixtures/claude-stream.ndjson", import.meta.url), "utf8");

describe("claude adapter", () => {
  it("streams stream-json, parses structured result + usage, and forwards live progress", async () => {
    const fake = createFakeProcessRunner({ claude: { stdout: stream, code: 0 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    expect(adapter.id).toBe("claude");
    expect(adapter.capabilities.toolEvents).toBe(true);

    const progress: AgentProgress[] = [];
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", label: "a", signal: new AbortController().signal },
      { runId: "r", seq: 0, onProgress: (p) => progress.push(p) },
    );
    expect(res.isOk()).toBe(true);
    const r = res._unsafeUnwrap();
    expect(r.data).toEqual({ n: 7 });
    expect(r.usage.outputTokens).toBe(106);

    // Live progress: model first, two WebFetch tool calls, rising token counts.
    expect(progress.find((p) => p.model)?.model).toBe("claude-opus-4-8[1m]");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["WebFetch", "WebFetch"]);
    expect(progress.filter((p) => typeof p.tokens === "number").map((p) => p.tokens)).toEqual([40, 80, 150]);

    const argv = fake.calls()[0]!.args;
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--json-schema");
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--permission-mode");
  });

  it("returns AdapterSpawn when a schema is requested but the result carries no structured output", async () => {
    const noStructured = JSON.stringify({ type: "result", is_error: false, result: "not json", usage: { input_tokens: 1, output_tokens: 1 } });
    const fake = createFakeProcessRunner({ claude: { stdout: noStructured, code: 0 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });

  it("returns an AdapterSpawn error on non-zero exit", async () => {
    const fake = createFakeProcessRunner({ claude: { stdout: "", stderr: "boom", code: 1 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    const res = await adapter.run(
      { prompt: "x", cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });
});
