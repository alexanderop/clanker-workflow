import { describe, it, expect } from "vitest";
import { createProcessRunner } from "./process-runner.js";

describe("createProcessRunner", () => {
  it("captures stdout and exit code from a real process", async () => {
    const runner = createProcessRunner();
    const out = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('hello'); process.exit(0)"],
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("hello");
  });

  it("closes stdin when none is provided, so stdin-reading commands terminate", async () => {
    // A child that waits for stdin EOF before exiting. If the runner never ends the
    // child's stdin pipe, `end` never fires and the process hangs forever (the bug
    // that froze every web-search `claude -p` agent). Closing stdin sends EOF → it exits.
    const runner = createProcessRunner();
    const out = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(0))"],
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    expect(out.code).toBe(0);
  }, 4000);

  it("invokes onLine per complete stdout line, in order, and still buffers full stdout", async () => {
    const runner = createProcessRunner();
    const linesSeen: string[] = [];
    const out = await runner.run({
      command: process.execPath,
      // Emit three lines over time; the last is newline-terminated.
      args: ["-e", "const w=s=>process.stdout.write(s);w('a\\n');setTimeout(()=>w('b\\nc\\n'),10)"],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onLine: (line) => linesSeen.push(line),
    });
    expect(linesSeen).toEqual(["a", "b", "c"]);
    expect(out.stdout).toBe("a\nb\nc\n");
  });

  it("flushes a trailing partial (non-newline-terminated) line via onLine", async () => {
    const runner = createProcessRunner();
    const linesSeen: string[] = [];
    const out = await runner.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('partial')"],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onLine: (line) => linesSeen.push(line),
    });
    expect(linesSeen).toEqual(["partial"]);
    expect(out.stdout).toBe("partial");
  });

  it("forwards stdin", async () => {
    const runner = createProcessRunner();
    const out = await runner.run({
      command: process.execPath,
      args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))"],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      stdin: "abc",
    });
    expect(out.stdout).toBe("ABC");
  });
});
