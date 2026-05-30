import type { ProcessRunner } from "@workflow/adapters";

export interface WorktreeFactoryDeps {
  readonly processRunner: ProcessRunner;
  readonly baseCwd: string;
  readonly tmpRoot: string;
  readonly runId: string;
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * Build a `makeIsolatedCwd(key)` that creates a detached git worktree under
 * `<tmpRoot>/<runId>/<safeKey>` via `git worktree add --detach`, returning a `cleanup`
 * that runs `git worktree remove --force`. Degrades gracefully (warn + reuse baseCwd, no-op
 * cleanup) when the worktree cannot be created (e.g. baseCwd is not a git repository).
 */
export function createWorktreeFactory(
  deps: WorktreeFactoryDeps,
): (key: string) => Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  return async (key) => {
    const safeKey = key.replace(/[^A-Za-z0-9._-]/g, "_");
    const path = `${deps.tmpRoot}/${deps.runId}/${safeKey}`;
    const signal = new AbortController().signal;
    const add = await deps.processRunner.run({
      command: "git",
      args: ["-C", deps.baseCwd, "worktree", "add", "--detach", path],
      cwd: deps.baseCwd,
      signal,
    });
    if (add.code !== 0) {
      deps.warn?.(
        `worktree isolation unavailable (git worktree add failed: ${add.stderr.trim() || "not a git repository"}); using base cwd`,
      );
      return { cwd: deps.baseCwd, cleanup: async () => undefined };
    }
    return {
      cwd: path,
      cleanup: async () => {
        // Best-effort: a failed removal leaks a worktree but must not reject the agent.
        try {
          const removed = await deps.processRunner.run({
            command: "git",
            args: ["-C", deps.baseCwd, "worktree", "remove", "--force", path],
            cwd: deps.baseCwd,
            signal,
          });
          if (removed.code !== 0) {
            deps.warn?.(`worktree cleanup failed for ${path} (git worktree remove exited ${removed.code})`);
          }
        } catch (e) {
          deps.warn?.(`worktree cleanup error for ${path}: ${String(e)}`);
        }
      },
    };
  };
}
