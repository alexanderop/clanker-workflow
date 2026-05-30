import { describe, it, expect } from "vitest";
import { runInSandbox, extractMeta } from "./sandbox.js";
import { profile, isProfile } from "./profile.js";

describe("sandbox", () => {
  it("extracts meta and returns the script's return value", async () => {
    const src = `
      export const meta = { name: "demo", description: "d", harness: "claude", phases: [] };
      const a = await getValue();
      return { a };
    `;
    const result = await runInSandbox(src, { getValue: async () => 42 });
    expect(result.meta.name).toBe("demo");
    expect(result.returnValue).toEqual({ a: 42 });
  });

  it("preserves meta.output when declared", () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", output: "./newsletters", phases: [] };\nreturn 1;`;
    expect(extractMeta(src).output).toBe("./newsletters");
  });

  it("rejects a non-string meta.output", () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", output: 42, phases: [] };\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/meta\.output/);
  });

  it("allows authoring imports from the published defineworkflow package", async () => {
    const src = `
      import { agent, phase, type WorkflowMeta, type JsonSchema } from "defineworkflow";

      export const meta = { name: "demo", description: "d", harness: "claude", phases: [{ title: "Run" }] } satisfies WorkflowMeta;
      phase("Run");
      const Out: JsonSchema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] };
      const result = await agent("answer", { schema: Out });
      return result;
    `;
    const result = await runInSandbox(src, {
      agent: async () => ({ answer: 42 }),
      phase: () => {},
    });
    expect(result.meta.name).toBe("demo");
    expect(result.returnValue).toEqual({ answer: 42 });
  });

  it("strips `import { profile }` and resolves the injected profile global", async () => {
    const src = `
      import { agent, defineWorkflow, profile } from "defineworkflow";

      export default defineWorkflow({
        name: "with-profile",
        description: "uses a profile",
        harness: "claude",
        phases: [{ title: "Run" }],
        async run() {
          const reviewer = profile({ model: "sonnet", instructions: "Be terse." });
          return await agent(reviewer, "review this");
        },
      });
    `;
    const seen: unknown[] = [];
    const result = await runInSandbox(src, {
      defineWorkflow: (workflow: unknown) => workflow,
      profile,
      agent: async (first: unknown) => {
        seen.push(first);
        return "ok";
      },
      parallel: async () => [],
      pipeline: async () => [],
      workflow: async () => null,
      phase: () => {},
      log: () => {},
      args: null,
      budget: { total: null, spent: () => 0, remaining: () => Infinity, record: () => {} },
    });
    expect(result.returnValue).toBe("ok");
    // The stripped import resolved to the injected global, producing a branded Profile that
    // flowed through as agent()'s first argument.
    expect(isProfile(seen[0])).toBe(true);
  });

  it("runs a workflow exported with defineWorkflow()", async () => {
    const src = `
      import { defineWorkflow, agent } from "workflow";

      export default defineWorkflow({
        name: "defined",
        description: "defined workflow",
        harness: "claude",
        phases: [{ title: "Run" }],
        async run() {
          const out = await agent("hello", { label: "a" });
          return { out };
        },
      });
    `;
    const result = await runInSandbox(src, {
      defineWorkflow: (workflow: unknown) => workflow,
      agent: async () => "hit",
      parallel: async () => [],
      pipeline: async () => [],
      workflow: async () => null,
      phase: () => {},
      log: () => {},
      args: null,
      budget: { total: null, spent: () => 0, remaining: () => Infinity, record: () => {} },
    });
    expect(result.meta).toMatchObject({ name: "defined", harness: "claude", phases: [{ title: "Run" }] });
    expect(result.returnValue).toEqual({ out: "hit" });
  });

  it("throws SandboxViolation when the script calls Date.now()", async () => {
    const src = `export const meta = { name: "x", description: "x", harness: "claude", phases: [] };\n const t = Date.now(); return t;`;
    await expect(runInSandbox(src, {})).rejects.toThrow(/SandboxViolation|Date.now/);
  });

  it("throws SandboxViolation when the script calls Math.random()", async () => {
    const src = `export const meta = { name: "x", description: "x", harness: "claude", phases: [] };\n return Math.random();`;
    await expect(runInSandbox(src, {})).rejects.toThrow(/SandboxViolation|Math.random/);
  });

  it("captures meta with no trailing semicolon (ASI)", async () => {
    const src = `export const meta = { name: "n", description: "n", harness: "claude", phases: [] }\nreturn 1;`;
    const result = await runInSandbox(src, {});
    expect(result.meta.name).toBe("n");
    expect(result.returnValue).toBe(1);
  });

  it("treats export default as the workflow return value", async () => {
    const src = `export const meta = { name: "n", description: "n", harness: "claude", phases: [] } satisfies WorkflowMeta;
const answer = await getValue();
export default { answer };`;
    const result = await runInSandbox(src, { getValue: async () => 42 });
    expect(result.returnValue).toEqual({ answer: 42 });
  });

  it("captures meta whose strings contain semicolons", async () => {
    const src = `export const meta = { name: "n", description: "do a; then b", harness: "claude", phases: [] };\nreturn 2;`;
    const result = await runInSandbox(src, {});
    expect(result.meta.name).toBe("n");
    expect(result.meta.description).toBe("do a; then b");
    expect(result.returnValue).toBe(2);
  });
});

describe("extractMeta", () => {
  it("reads meta without executing agent calls", () => {
    const src = `export const meta = { name: "demo", description: "d", whenToUse: "demo work", harness: "claude", phases: [{ title: "A" }] } as const
const x = await agent("should never run");
return x;`;
    const meta = extractMeta(src);
    expect(meta.name).toBe("demo");
    expect(meta.whenToUse).toBe("demo work");
    expect(meta.phases).toEqual([{ title: "A" }]);
  });

  it("throws when meta is missing", () => {
    expect(() => extractMeta(`const y = 1; export {};`)).toThrow(/must export `const meta`/);
  });

  it("rejects a non-literal meta (function call) without executing it", () => {
    const src = `export const meta = build();\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: non-literal value in meta/);
  });

  it("rejects a spread inside meta", () => {
    const src = `export const meta = { ...base, name: "x", description: "d", harness: "claude" };\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: spread not allowed in meta/);
  });

  it("rejects template interpolation inside meta", () => {
    const src = "export const meta = { name: `wf-${id}`, description: \"d\", harness: \"claude\" };\nreturn 1;";
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: template interpolation not allowed/);
  });

  it("rejects meta that is not the first statement", () => {
    const src = `const x = 1;\nexport const meta = { name: "x", description: "d", harness: "claude" };\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: .*first statement/);
  });
});

describe("extractMeta literal evaluation", () => {
  it("evaluates array, nested-object, and quote-less template literal values", () => {
    const src = `export const meta = {
      name: \`demo\`,
      description: "d",
      harness: "claude",
      phases: [{ title: "A" }, { title: "B" }],
      output: "./out",
    };
    return 1;`;
    const meta = extractMeta(src);
    expect(meta.name).toBe("demo"); // template literal with no interpolation
    expect(meta.phases).toEqual([{ title: "A" }, { title: "B" }]);
    expect(meta.output).toBe("./out");
  });

  it("evaluates a negative-number value and a string-literal key inside a nested field", () => {
    // -3 exercises the negative-number UnaryExpression branch; "weight" the string-literal key branch.
    // phases is preserved verbatim by validateMeta, so the evaluated values survive into the result.
    const src = `export const meta = { name: "n", description: "d", harness: "claude", phases: [{ "weight": -3 }] };\nreturn 1;`;
    const meta = extractMeta(src);
    expect(meta.phases).toEqual([{ weight: -3 }]);
  });

  it("rejects a sparse array in meta", () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", phases: [1, , 3] };\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: sparse arrays not allowed/);
  });

  it("rejects a spread element inside an array in meta", () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", phases: [...others] };\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: spread not allowed/);
  });

  it("rejects template interpolation inside a nested array value", () => {
    const src = "export const meta = { name: \"n\", description: \"d\", harness: \"claude\", phases: [`p-${id}`] };\nreturn 1;";
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: template interpolation not allowed/);
  });

  it("rejects a method shorthand inside meta", () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", run() { return 1; } };\nreturn 1;`;
    expect(() => extractMeta(src)).toThrow(/SandboxViolation: methods\/accessors not allowed/);
  });
});

describe("extractMeta defineWorkflow validation", () => {
  function defWf(body: string): string {
    return `import { defineWorkflow } from "defineworkflow";\nexport default defineWorkflow(${body});`;
  }

  it("ignores the run() method but evaluates the literal metadata fields", () => {
    const meta = extractMeta(
      defWf(`{ name: "wf", description: "d", harness: "codex", phases: [{ title: "P" }], async run() { return 1; } }`),
    );
    expect(meta).toMatchObject({ name: "wf", harness: "codex", phases: [{ title: "P" }] });
  });

  it("rejects a non-object-literal argument to defineWorkflow", () => {
    expect(() => extractMeta(defWf("makeMeta()"))).toThrow(
      /SandboxViolation: defineWorkflow argument must be an object literal/,
    );
  });

  it("rejects a spread inside the defineWorkflow metadata", () => {
    expect(() => extractMeta(defWf(`{ ...base, name: "wf", description: "d", harness: "claude", run() {} }`))).toThrow(
      /SandboxViolation: spread not allowed in defineWorkflow metadata/,
    );
  });

  it("rejects a computed key inside the defineWorkflow metadata", () => {
    expect(() =>
      extractMeta(defWf(`{ ["na" + "me"]: "wf", description: "d", harness: "claude", run() {} }`)),
    ).toThrow(/SandboxViolation: computed keys not allowed in defineWorkflow metadata/);
  });

  it("rejects a non-literal metadata field value in defineWorkflow", () => {
    expect(() =>
      extractMeta(defWf(`{ name: "wf", description: "d", harness: "claude", output: getOutput(), run() {} }`)),
    ).toThrow(/SandboxViolation: non-literal value in defineWorkflow\.output/);
  });

  it("rejects a getter for a metadata field in defineWorkflow", () => {
    expect(() =>
      extractMeta(defWf(`{ name: "wf", description: "d", harness: "claude", get output() { return "x"; }, run() {} }`)),
    ).toThrow(/SandboxViolation: methods\/accessors not allowed in defineWorkflow\.output/);
  });
});

describe("runInSandbox compile + runtime errors", () => {
  it("surfaces a syntax error in the workflow body as a thrown error", async () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", phases: [] };\nconst x = (;`;
    await expect(runInSandbox(src, {})).rejects.toThrow();
  });

  it("rejects a script that exports neither meta nor a defineWorkflow default", async () => {
    const src = `const x = 1;\nexport {};`;
    await expect(runInSandbox(src, {})).rejects.toThrow(/must export `const meta`/);
  });

  it("propagates a runtime error thrown by injected globals", async () => {
    const src = `export const meta = { name: "n", description: "d", harness: "claude", phases: [] };\nreturn await boom();`;
    await expect(
      runInSandbox(src, {
        boom: async () => {
          throw new Error("kaboom");
        },
      }),
    ).rejects.toThrow(/kaboom/);
  });
});
