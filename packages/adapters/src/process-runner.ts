import { spawn } from "node:child_process";

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Called once per complete stdout line as it arrives (for streaming adapters). */
  readonly onLine?: (line: string) => void;
}

export interface ProcessOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessOutput>;
}

/** Default runner: spawns a real child process, buffers stdout/stderr, resolves on close. */
export function createProcessRunner(): ProcessRunner {
  return {
    run: (spec) =>
      new Promise<ProcessOutput>((resolve, reject) => {
        const child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd,
          signal: spec.signal,
          env: spec.env ? { ...process.env, ...spec.env } : process.env,
        });
        let stdout = "";
        let stderr = "";
        // Rolling buffer for line splitting: invoke `onLine` per complete line while
        // still accumulating the full `stdout` for the final ProcessOutput (back-compat).
        let pending = "";
        const onLine = spec.onLine;
        child.stdout.on("data", (d: Buffer) => {
          const text = d.toString("utf8");
          stdout += text;
          if (!onLine) return;
          pending += text;
          let nl = pending.indexOf("\n");
          while (nl !== -1) {
            onLine(pending.slice(0, nl));
            pending = pending.slice(nl + 1);
            nl = pending.indexOf("\n");
          }
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
          // Flush a trailing partial line (output not newline-terminated).
          if (onLine && pending.length > 0) onLine(pending);
          resolve({ code, stdout, stderr });
        });
        // Always end stdin: write the payload when provided, otherwise send a bare
        // EOF. Leaving the pipe open hangs children that read stdin in a tool loop —
        // e.g. `claude -p` web-search agents block forever waiting on input.
        child.stdin.end(spec.stdin ?? undefined);
      }),
  };
}
