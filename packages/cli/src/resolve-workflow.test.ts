import { describe, it, expect } from "vitest";
import { createScriptedRunner, createJournal, WorkflowThrow } from "@workflow/core";
import { runWorkflow } from "./orchestrator.js";
import { buildWorkflowResolver } from "./resolve-workflow.js";

const CHILD_SOURCE = `export const meta = { name: "child", description: "c" } as const
const v = await agent("hi", { label: "k" });
return { child: v };`;

const PARENT_SOURCE = `export const meta = { name: "parent", description: "p" } as const
const out = await workflow("child");
return out;`;

describe("buildWorkflowResolver", () => {
  it("resolves a nested workflow by name and runs it end-to-end", async () => {
    const readTextFile = (path: string): string | undefined => {
      if (path.endsWith("child.ts")) return CHILD_SOURCE;
      return undefined;
    };

    const resolveWorkflow = buildWorkflowResolver({
      homeDir: "/home",
      cwd: "/proj",
      readTextFile,
    });

    const runner = createScriptedRunner({ k: { text: "deep" } });

    const result = await runWorkflow({
      source: PARENT_SOURCE,
      args: {},
      runner,
      runId: "r1",
      cwd: "/proj",
      concurrency: 4,
      maxAgents: 1000,
      budgetTotal: null,
      journal: createJournal(),
      emit: () => {},
      now: () => 0,
      resolveWorkflow,
    });

    expect(result._unsafeUnwrap().returnValue).toEqual({ child: "deep" });
  });

  it("resolves from the bundled dir when no project/personal copy exists", async () => {
    const resolve = buildWorkflowResolver({
      homeDir: "/home",
      cwd: "/proj",
      bundledDir: "/bundled",
      readTextFile: (p) => (p === "/bundled/child.ts" ? CHILD_SOURCE : undefined),
    });
    const loaded = await resolve("child");
    expect(loaded.meta.name).toBe("child");
  });

  it("throws a WorkflowThrow (AdapterSpawn) when the named workflow is missing", async () => {
    const resolve = buildWorkflowResolver({ homeDir: "/home", cwd: "/proj", readTextFile: () => undefined });
    await expect(resolve("ghost")).rejects.toBeInstanceOf(WorkflowThrow);
    await expect(resolve("ghost")).rejects.toMatchObject({
      workflowError: { kind: "AdapterSpawn", adapter: "workflow" },
    });
  });
});
