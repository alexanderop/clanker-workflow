import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createClaudeAdapter } from "./claude.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

const fixture = readFileSync(new URL("../fixtures/claude-result.json", import.meta.url), "utf8");

describe("claude adapter", () => {
  it("builds the expected argv and parses structured result + usage from the fixture", async () => {
    const fake = createFakeProcessRunner({ claude: { stdout: fixture, code: 0 } });
    const adapter = createClaudeAdapter({ processRunner: fake });
    expect(adapter.id).toBe("claude");
    expect(adapter.capabilities.nativeSchema).toBe(true);

    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", label: "a", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res.isOk()).toBe(true);
    const r = res._unsafeUnwrap();
    expect(r.data).toEqual({ n: 7 });
    expect(r.usage.outputTokens).toBeGreaterThanOrEqual(0);

    const argv = fake.calls()[0]!.args;
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--json-schema");
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
