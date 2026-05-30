import { WorkflowThrow } from "@workflow/core";
import type { LoadedWorkflow } from "@workflow/core";
import { resolveSavedWorkflow } from "./resolve.js";
import { loadWorkflow } from "./loader.js";

export interface WorkflowResolverDeps {
  readonly homeDir: string;
  readonly cwd: string;
  readonly readTextFile: (path: string) => string | undefined;
  readonly bundledDir?: string | undefined;
}

/** Build the nested-workflow resolver the core runtime calls for `workflow("name")`. */
export function buildWorkflowResolver(
  deps: WorkflowResolverDeps,
): (name: string, args?: unknown) => Promise<LoadedWorkflow> {
  return async (name) => {
    const resolved = resolveSavedWorkflow(name, {
      homeDir: deps.homeDir,
      cwd: deps.cwd,
      readFile: deps.readTextFile,
      bundledDir: deps.bundledDir,
    });
    if (!resolved) {
      throw new WorkflowThrow({
        kind: "AdapterSpawn",
        adapter: "workflow",
        cause: `no workflow named "${name}"`,
      });
    }
    return loadWorkflow(resolved.source);
  };
}
