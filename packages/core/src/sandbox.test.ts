import { describe, it, expect } from "vitest";
import { runInSandbox } from "./sandbox.js";

describe("sandbox", () => {
  it("extracts meta and returns the script's return value", async () => {
    const src = `
      export const meta = { name: "demo", description: "d", phases: [] };
      const a = await getValue();
      return { a };
    `;
    const result = await runInSandbox(src, { getValue: async () => 42 });
    expect(result.meta.name).toBe("demo");
    expect(result.returnValue).toEqual({ a: 42 });
  });

  it("throws SandboxViolation when the script calls Date.now()", async () => {
    const src = `export const meta = { name: "x", description: "", phases: [] };\n const t = Date.now(); return t;`;
    await expect(runInSandbox(src, {})).rejects.toThrow(/SandboxViolation|Date.now/);
  });

  it("throws SandboxViolation when the script calls Math.random()", async () => {
    const src = `export const meta = { name: "x", description: "", phases: [] };\n return Math.random();`;
    await expect(runInSandbox(src, {})).rejects.toThrow(/SandboxViolation|Math.random/);
  });

  it("captures meta with no trailing semicolon (ASI)", async () => {
    const src = `export const meta = { name: "n", description: "", phases: [] }\nreturn 1;`;
    const result = await runInSandbox(src, {});
    expect(result.meta.name).toBe("n");
    expect(result.returnValue).toBe(1);
  });

  it("captures meta whose strings contain semicolons", async () => {
    const src = `export const meta = { name: "n", description: "do a; then b", phases: [] };\nreturn 2;`;
    const result = await runInSandbox(src, {});
    expect(result.meta.name).toBe("n");
    expect(result.meta.description).toBe("do a; then b");
    expect(result.returnValue).toBe(2);
  });
});
