import { describe, it, expect, expectTypeOf } from "vitest";
import {
  agent,
  z,
  defineWorkflow,
  profile,
  parallel,
  pipeline,
  phase,
  log,
  workflow,
  budget,
  args,
} from "./index.js";

describe("authoring surface", () => {
  it("re-exports the engine's zod instance", () => {
    expect(typeof z.object).toBe("function");
    expect(typeof z.string).toBe("function");
  });

  it("defineWorkflow returns the definition object unchanged (identity, type-safe)", () => {
    const def = {
      name: "demo",
      description: "d",
      harness: "claude" as const,
      run: async () => ({ ok: true }),
    };
    expect(defineWorkflow(def)).toBe(def);
  });

  it("profile freezes a copy of the config and brands it", () => {
    const p = profile({ adapter: "claude", model: "sonnet", instructions: "Be terse." });
    expect(p.__workflowProfile).toBe(true);
    expect(p.config).toEqual({ adapter: "claude", model: "sonnet", instructions: "Be terse." });
    expect(Object.isFrozen(p.config)).toBe(true);
  });

  it("the runtime primitive stubs throw outside the sandbox", () => {
    // These are authoring stubs only — the runner strips the import and injects
    // the live runtime at execution time, so calling them directly must fail loudly.
    expect(() => agent("p")).toThrow(/workflow run/);
    expect(() => agent(profile({ model: "sonnet" }), "p")).toThrow(/workflow run/);
    expect(() => parallel([])).toThrow(/workflow run/);
    expect(() => pipeline([], async () => undefined)).toThrow(/workflow run/);
    expect(() => phase("x")).toThrow(/workflow run/);
    expect(() => log("x")).toThrow(/workflow run/);
    expect(() => workflow("x")).toThrow(/workflow run/);
  });

  it("the budget stub has a null total and throwing accessors; args is undefined", () => {
    expect(budget.total).toBeNull();
    expect(() => budget.spent()).toThrow(/workflow run/);
    expect(() => budget.remaining()).toThrow(/workflow run/);
    expect(() => budget.record(1)).toThrow(/workflow run/);
    expect(args).toBeUndefined();
  });

  it("infers agent's return type from a zod schema", () => {
    // Compile-time assertion: only type-checks if the agent() overload infers the
    // schema's output. Never executed (the stub throws); `pnpm typecheck` is the gate.
    async function _typecheck(): Promise<void> {
      const out = await agent("p", { schema: z.object({ title: z.string(), n: z.number() }) });
      expectTypeOf(out).toEqualTypeOf<{ title: string; n: number }>();
    }
    expect(typeof _typecheck).toBe("function");
  });

  it("returns unknown when no schema is given", () => {
    async function _typecheck(): Promise<void> {
      const out = await agent("p");
      expectTypeOf(out).toBeUnknown();
    }
    expect(typeof _typecheck).toBe("function");
  });
});
