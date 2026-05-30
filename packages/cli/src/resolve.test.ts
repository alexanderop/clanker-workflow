import { describe, it, expect } from "vitest";
import { resolveSavedWorkflow, type ResolveDeps } from "./resolve.js";

function deps(files: Record<string, string>, bundledDir?: string): ResolveDeps {
  return { homeDir: "/home/me", cwd: "/proj", readFile: (p) => files[p], bundledDir };
}

const projTs = "/proj/.workflow/workflows/deep.ts";
const projJs = "/proj/.workflow/workflows/deep.js";
const homeTs = "/home/me/.workflow/workflows/deep.ts";

describe("resolveSavedWorkflow", () => {
  it("prefers the project workflow over the personal one", () => {
    const r = resolveSavedWorkflow("deep", deps({ [projTs]: "PROJECT", [homeTs]: "HOME" }));
    expect(r?.source).toBe("PROJECT");
    expect(r?.path).toBe(projTs);
  });

  it("prefers .ts over .js within the same scope", () => {
    const r = resolveSavedWorkflow("deep", deps({ [projTs]: "TS", [projJs]: "JS" }));
    expect(r?.source).toBe("TS");
  });

  it("falls back to the personal workflow when no project one exists", () => {
    const r = resolveSavedWorkflow("deep", deps({ [homeTs]: "HOME" }));
    expect(r?.source).toBe("HOME");
    expect(r?.path).toBe(homeTs);
  });

  it("returns undefined on a miss", () => {
    expect(resolveSavedWorkflow("nope", deps({}))).toBeUndefined();
  });

  it("resolves a bundled workflow when no project/personal copy exists", () => {
    const r = resolveSavedWorkflow("deep-research", deps({ "/bundled/deep-research.ts": "BUNDLED" }, "/bundled"));
    expect(r?.source).toBe("BUNDLED");
    expect(r?.path).toBe("/bundled/deep-research.ts");
  });

  it("project copy wins over bundled", () => {
    const r = resolveSavedWorkflow(
      "deep",
      deps({ "/proj/.workflow/workflows/deep.ts": "PROJECT", "/bundled/deep.ts": "BUNDLED" }, "/bundled"),
    );
    expect(r?.source).toBe("PROJECT");
  });

  it("bundled is ignored when bundledDir is not provided", () => {
    expect(resolveSavedWorkflow("nope", deps({}))).toBeUndefined();
  });
});
