import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { AgentProgress } from "@workflow/core";
import { createCodexAdapter } from "./codex.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

const finalMessage = readFileSync(new URL("../fixtures/codex-result.txt", import.meta.url), "utf8");
const stream = readFileSync(new URL("../fixtures/codex-stream.ndjson", import.meta.url), "utf8");

describe("codex adapter", () => {
  it("streams exec --json, reads the final message from -o, and reports real usage + progress", async () => {
    const files = new Map<string, string>();
    const fake = createFakeProcessRunner({
      codex: (spec) => {
        const oIndex = spec.args.indexOf("-o");
        const outPath = spec.args[oIndex + 1]!;
        files.set(outPath, finalMessage);
        return { stdout: stream, code: 0 };
      },
    });
    const adapter = createCodexAdapter({
      processRunner: fake,
      fileStore: {
        writeTemp: async (name, content) => { const p = `/tmp/${name}`; files.set(p, content); return p; },
        read: async (p) => files.get(p) ?? "",
        cleanup: async () => {},
      },
    });
    expect(adapter.id).toBe("codex");
    expect(adapter.capabilities.toolEvents).toBe(true);

    const progress: AgentProgress[] = [];
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", label: "a", signal: new AbortController().signal },
      { runId: "r", seq: 0, onProgress: (p) => progress.push(p) },
    );
    expect(res.isOk()).toBe(true);
    const r = res._unsafeUnwrap();
    expect(r.data).toEqual({ n: 7 });
    // Real usage from the terminal turn.completed event (not the char estimate).
    expect(r.usage.outputTokens).toBe(18);
    expect(r.usage.approximate).toBeUndefined();

    expect(progress.find((p) => p.model)?.model).toBe("gpt-5-codex");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["command_execution", "search"]);

    const argv = fake.calls()[0]!.args;
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--output-schema");
    expect(argv).toContain("-o");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).not.toContain("--full-auto");
  });

  it("returns AdapterSpawn on non-zero exit", async () => {
    const adapter = createCodexAdapter({
      processRunner: createFakeProcessRunner({ codex: { stdout: "", stderr: "bad", code: 2 } }),
      fileStore: { writeTemp: async () => "/tmp/s", read: async () => "", cleanup: async () => {} },
    });
    const res = await adapter.run({ prompt: "x", cwd: "/tmp", signal: new AbortController().signal }, { runId: "r", seq: 0 });
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });
});
