import { describe, it, expect, vi } from "vitest";
import type { ProcessRunner, ProcessSpec, ProcessOutput } from "@workflow/adapters";
import { createWorktreeFactory } from "./worktree.js";

function fakeRunner(output: ProcessOutput) {
  const calls: ProcessSpec[] = [];
  return {
    calls,
    runner: {
      run: async (spec: ProcessSpec) => {
        calls.push(spec);
        return output;
      },
    } satisfies ProcessRunner,
  };
}

describe("createWorktreeFactory", () => {
  it("happy path: creates worktree and cleanup removes it", async () => {
    const { calls, runner } = fakeRunner({ code: 0, stdout: "", stderr: "" });
    const factory = createWorktreeFactory({
      processRunner: runner,
      baseCwd: "/repo",
      tmpRoot: "/tmp/wt",
      runId: "run-1",
    });

    const result = await factory("0:default:a");

    expect(result.cwd).toBe("/tmp/wt/run-1/0_default_a");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "add", "--detach", "/tmp/wt/run-1/0_default_a"]);
    expect(calls[0]!.cwd).toBe("/repo");

    await result.cleanup();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.command).toBe("git");
    expect(calls[1]!.args).toEqual(["-C", "/repo", "worktree", "remove", "--force", "/tmp/wt/run-1/0_default_a"]);
    expect(calls[1]!.cwd).toBe("/repo");
  });

  it("graceful degrade: falls back to baseCwd and warn is called once, cleanup is no-op", async () => {
    const { calls, runner } = fakeRunner({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    const warn = vi.fn();
    const factory = createWorktreeFactory({
      processRunner: runner,
      baseCwd: "/repo",
      tmpRoot: "/tmp/wt",
      runId: "run-1",
      warn,
    });

    const result = await factory("k");

    expect(result.cwd).toBe("/repo");
    expect(warn).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);

    await result.cleanup();

    // cleanup must not issue any further process calls
    expect(calls).toHaveLength(1);
  });
});
