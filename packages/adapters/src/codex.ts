import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";
import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, AgentRequest, AgentResult, RunCtx, WorkflowError } from "@workflow/core";
import type { ProcessRunner } from "./process-runner.js";
import { CAPABILITIES } from "./detect.js";
import { translateCodexLine, extractCodexUsage } from "./codex-stream.js";

export interface FileStore {
  writeTemp(name: string, content: string): Promise<string>;
  read(path: string): Promise<string>;
  cleanup(paths: readonly string[]): Promise<void>;
}

export function createDefaultFileStore(): FileStore {
  return {
    writeTemp: async (name, content) => {
      const dir = await mkdtemp(join(tmpdir(), "wf-codex-"));
      const path = join(dir, name);
      await writeFile(path, content, "utf8");
      return path;
    },
    read: async (path) => readFile(path, "utf8"),
    cleanup: async (paths) => {
      for (const p of paths) await rm(p, { force: true }).catch(() => {});
    },
  };
}

export interface CodexAdapterDeps {
  readonly processRunner: ProcessRunner;
  readonly fileStore?: FileStore;
  readonly bin?: string;
}

export function createCodexAdapter(deps: CodexAdapterDeps): AgentRunner {
  const bin = deps.bin ?? "codex";
  const fileStore = deps.fileStore ?? createDefaultFileStore();
  return {
    id: "codex",
    capabilities: CAPABILITIES.codex,
    run: async (req: AgentRequest, ctx: RunCtx): Promise<Result<AgentResult, WorkflowError>> => {
      const created: string[] = [];
      const outPath = await fileStore.writeTemp("codex-out.txt", "");
      created.push(outPath);
      // `--json` streams events to stdout (live progress) while `-o` writes the final
      // assistant message to a file (authoritative result/schema source). YOLO mode:
      // `--full-auto` sandboxes execution (no network), which blocks web research, so
      // bypass approvals and the sandbox — the run is already gated by the consent prompt.
      const args = ["exec", "--json", "--skip-git-repo-check", "-C", req.cwd, "--dangerously-bypass-approvals-and-sandbox", "-o", outPath];
      if (req.schema) {
        const schemaPath = await fileStore.writeTemp("codex-schema.json", JSON.stringify(req.schema));
        created.push(schemaPath);
        args.push("--output-schema", schemaPath);
      }
      if (req.model) args.push("-m", req.model);
      args.push(req.prompt);

      const onProgress = ctx.onProgress;
      const onLine = onProgress
        ? (line: string): void => {
            for (const p of translateCodexLine(line)) onProgress(p);
          }
        : undefined;

      try {
        const out = await deps.processRunner.run({
          command: bin,
          args,
          cwd: req.cwd,
          signal: req.signal,
          ...(onLine ? { onLine } : {}),
        });
        if (out.code !== 0) {
          return err({ kind: "AdapterSpawn", adapter: "codex", cause: out.stderr || `exit ${out.code}` });
        }
        const finalMessage = (await fileStore.read(outPath)).trim();
        let data: unknown;
        if (req.schema) {
          try {
            data = JSON.parse(finalMessage);
          } catch {
            return err({ kind: "AdapterSpawn", adapter: "codex", cause: "final message was not valid JSON for the schema" });
          }
        }
        // Prefer real usage from the stream's terminal `turn.completed`; fall back to a
        // char-count estimate only when the stream carried no usage.
        const realUsage = extractCodexUsage(out.stdout);
        const usage = realUsage
          ? { inputTokens: realUsage.inputTokens, outputTokens: realUsage.outputTokens }
          : { inputTokens: 0, outputTokens: Math.ceil(finalMessage.length / 4), approximate: true };
        const result: AgentResult = {
          text: finalMessage,
          ...(data !== undefined ? { data } : {}),
          usage,
          toolCalls: [],
        };
        return ok(result);
      } finally {
        await fileStore.cleanup(created);
      }
    },
  };
}
