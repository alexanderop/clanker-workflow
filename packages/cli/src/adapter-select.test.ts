import { describe, it, expect } from "vitest";
import { createFakeProcessRunner } from "@workflow/adapters";
import { selectAdapterId, buildRunner, buildRunnerMap } from "./adapter-select.js";

describe("selectAdapterId", () => {
  const detected = ["codex", "copilot", "raw-api"] as const;

  it("meta default wins over everything", () => {
    expect(selectAdapterId({ metaDefault: "copilot", cliFlag: "codex", configDefault: "claude", detected })).toBe("copilot");
  });

  it("CLI flag wins over config + auto-detect", () => {
    expect(selectAdapterId({ cliFlag: "codex", configDefault: "claude", detected })).toBe("codex");
  });

  it("config default wins over auto-detect", () => {
    expect(selectAdapterId({ configDefault: "copilot", detected })).toBe("copilot");
  });

  it("auto-detect prefers claude > codex > copilot > raw-api", () => {
    expect(selectAdapterId({ detected: ["copilot", "codex", "claude"] })).toBe("claude");
    expect(selectAdapterId({ detected: ["copilot", "codex"] })).toBe("codex");
    expect(selectAdapterId({ detected: [] })).toBe("raw-api");
  });

  it("ignores an invalid explicit id and falls through", () => {
    expect(selectAdapterId({ metaDefault: "bogus", detected: ["codex"] })).toBe("codex");
  });
});

describe("buildRunner", () => {
  const processRunner = createFakeProcessRunner({});

  it("builds a claude/codex/copilot runner with the right id", () => {
    expect(buildRunner("claude", {}, { processRunner })._unsafeUnwrap().id).toBe("claude");
    expect(buildRunner("codex", {}, { processRunner })._unsafeUnwrap().id).toBe("codex");
    expect(buildRunner("copilot", {}, { processRunner })._unsafeUnwrap().id).toBe("copilot");
  });

  it("builds raw-api when a complete fn is supplied", () => {
    const complete = async () => ({ text: "x", usage: { inputTokens: 0, outputTokens: 0 } });
    expect(buildRunner("raw-api", {}, { processRunner, complete })._unsafeUnwrap().id).toBe("raw-api");
  });

  it("errors (AdapterSpawn) for raw-api without a complete fn", () => {
    const r = buildRunner("raw-api", {}, { processRunner });
    expect(r.isErr()).toBe(true);
    expect(r._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });
});

describe("buildRunnerMap", () => {
  const processRunner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };

  it("builds runners for detected adapters, skips raw-api without a key", () => {
    const map = buildRunnerMap(["claude", "codex"], {}, { processRunner });

    expect(map.resolveRunner("claude")).toBeTruthy();
    expect(map.resolveRunner("claude")?.id).toBe("claude");

    expect(map.resolveRunner("codex")).toBeTruthy();
    expect(map.resolveRunner("codex")?.id).toBe("codex");

    // raw-api is a candidate but fails to build without complete → absent
    expect(map.resolveRunner("raw-api")).toBeUndefined();

    // completely unknown id → undefined
    expect(map.resolveRunner("bogus")).toBeUndefined();

    expect(map.ids).toContain("claude");
    expect(map.ids).toContain("codex");
    expect(map.ids).not.toContain("raw-api");
  });

  it("includes raw-api when a complete fn is provided, even with empty detected", () => {
    const complete = async () => ({ text: "x", usage: { inputTokens: 0, outputTokens: 0 } });
    const map = buildRunnerMap([], {}, { processRunner, complete });

    expect(map.resolveRunner("raw-api")).toBeTruthy();
    expect(map.ids).toContain("raw-api");
  });
});
