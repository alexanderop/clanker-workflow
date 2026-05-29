import { describe, it, expect } from "vitest";
import { CAPABILITIES, detectAdapters } from "./detect.js";

describe("detect", () => {
  it("exposes a capability matrix for the known harnesses", () => {
    expect(CAPABILITIES.claude.nativeSchema).toBe(true);
    expect(CAPABILITIES.codex.nativeSchema).toBe(true);
    expect(CAPABILITIES.copilot.nativeSchema).toBe(false);
    expect(CAPABILITIES["raw-api"].reportsTokens).toBe(true);
  });

  it("detects only the harnesses present on PATH (injected probe)", async () => {
    const present = await detectAdapters({ exists: async (bin) => bin === "codex" });
    expect(present).toContain("codex");
    expect(present).not.toContain("claude");
  });
});
