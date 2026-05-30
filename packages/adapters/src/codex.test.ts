import { describe, it, expect } from "vitest";
import { readFile, access } from "node:fs/promises";
import { createCodexAdapter, createDefaultFileStore, type FileStore } from "./codex.js";
import { createFakeProcessRunner } from "./fake-process-runner.js";

// Derive request/ctx types from the adapter's own signature so this test file
// does not import bare "@workflow/core" types directly (Vite resolves that
// inconsistently when the adapter is also pulled in transitively).
type RunFn = ReturnType<typeof createCodexAdapter>["run"];
type AgentRequest = Parameters<RunFn>[0];
type RunCtx = Parameters<RunFn>[1];

const schema: Record<string, unknown> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

function req(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: "What is 2+2?",
    cwd: "/work",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function ctx(): RunCtx {
  return { runId: "r", seq: 0 };
}

// An in-memory FileStore that records every temp file it writes so tests can
// assert the schema content that was passed to codex, plus what got cleaned up.
function createFakeFileStore(): FileStore & { written: Map<string, string>; cleaned: string[] } {
  const written = new Map<string, string>();
  const cleaned: string[] = [];
  return {
    written,
    cleaned,
    writeTemp: async (name, content) => {
      const path = `/tmp/${name}`;
      written.set(path, content);
      return path;
    },
    read: async (path) => written.get(path) ?? "",
    cleanup: async (paths) => {
      for (const p of paths) cleaned.push(p);
    },
  };
}

// `codex exec --json` streams NDJSON; the translator collects the final
// agent_message text and turn.completed usage.
function codexStream(message: string, usage?: { input: number; output: number }): string {
  const lines = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }),
  ];
  if (usage) {
    lines.push(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: usage.input, output_tokens: usage.output },
      }),
    );
  }
  return lines.join("\n");
}

describe("codex adapter", () => {
  it("declares id and capabilities", () => {
    const fake = createFakeProcessRunner({ codex: { stdout: "", code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    expect(adapter.id).toBe("codex");
    expect(adapter.capabilities.nativeSchema).toBe(true);
  });

  it("writes the schema to a temp file, passes --output-schema, and builds argv", async () => {
    const store = createFakeFileStore();
    const fake = createFakeProcessRunner({ codex: { stdout: codexStream('{"answer":"4"}'), code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: store });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);

    // schema serialized into the temp file
    expect([...store.written.values()]).toContain(JSON.stringify(schema));

    const argv = fake.calls()[0]!.args;
    expect(argv.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    const i = argv.indexOf("--output-schema");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("/tmp/codex-schema.json");
    // prompt is the last positional arg
    expect(argv[argv.length - 1]).toBe("What is 2+2?");
  });

  it("does not pass --output-schema when there is no schema", async () => {
    const fake = createFakeProcessRunner({ codex: { stdout: codexStream("plain text"), code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const res = await adapter.run(req(), ctx());
    expect(res.isOk()).toBe(true);
    expect(fake.calls()[0]!.args).not.toContain("--output-schema");
  });

  it("appends -m only when req.model is set", async () => {
    const fakeNo = createFakeProcessRunner({ codex: { stdout: codexStream("x"), code: 0 } });
    await createCodexAdapter({ processRunner: fakeNo, fileStore: createFakeFileStore() }).run(req(), ctx());
    expect(fakeNo.calls()[0]!.args).not.toContain("-m");

    const fakeYes = createFakeProcessRunner({ codex: { stdout: codexStream("x"), code: 0 } });
    await createCodexAdapter({ processRunner: fakeYes, fileStore: createFakeFileStore() }).run(
      req({ model: "gpt-5" }),
      ctx(),
    );
    const argv = fakeYes.calls()[0]!.args;
    expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5");
  });

  it("parses the final message as JSON for a schema request and returns real usage", async () => {
    const fake = createFakeProcessRunner({
      codex: { stdout: codexStream('{"answer":"4"}', { input: 10, output: 5 }), code: 0 },
    });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);
    const value = res._unsafeUnwrap();
    expect(value.data).toEqual({ answer: "4" });
    expect(value.usage.inputTokens).toBe(10);
    expect(value.usage.outputTokens).toBe(5);
  });

  it("estimates output tokens when the stream reports none", async () => {
    const fake = createFakeProcessRunner({ codex: { stdout: codexStream('{"answer":"hello"}'), code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);
    const usage = res._unsafeUnwrap().usage as { outputTokens: number; approximate?: boolean };
    expect(usage.approximate).toBe(true);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it("returns plain text (no data) when there is no schema", async () => {
    const fake = createFakeProcessRunner({ codex: { stdout: codexStream("just prose"), code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const res = await adapter.run(req(), ctx());
    expect(res.isOk()).toBe(true);
    const value = res._unsafeUnwrap();
    expect(value.text).toBe("just prose");
    expect(value.data).toBeUndefined();
  });

  it("returns AdapterSpawn when the CLI exits non-zero", async () => {
    const fake = createFakeProcessRunner({ codex: { stdout: "", stderr: "kaboom", code: 1 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isErr()).toBe(true);
    const e = res._unsafeUnwrapErr();
    expect(e.kind).toBe("AdapterSpawn");
    expect(e.kind === "AdapterSpawn" && e.cause).toContain("kaboom");
  });

  it("returns AdapterSpawn when the final message is not valid JSON for a schema", async () => {
    const fake = createFakeProcessRunner({ codex: { stdout: codexStream("not json"), code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isErr()).toBe(true);
    const e = res._unsafeUnwrapErr();
    expect(e.kind).toBe("AdapterSpawn");
    expect(e.kind === "AdapterSpawn" && e.cause).toMatch(/JSON/i);
  });

  it("always cleans up the temp schema file (even on success)", async () => {
    const store = createFakeFileStore();
    const fake = createFakeProcessRunner({ codex: { stdout: codexStream('{"answer":"4"}'), code: 0 } });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: store });
    await adapter.run(req({ schema }), ctx());
    expect(store.cleaned).toContain("/tmp/codex-schema.json");
  });

  it("uses createDefaultFileStore by default (no fileStore dep) and still completes", async () => {
    // No fileStore provided -> the adapter constructs createDefaultFileStore(),
    // exercising the real fs-backed writeTemp/cleanup path.
    const fake = createFakeProcessRunner({
      codex: (spec) => {
        expect(spec.args.indexOf("--output-schema")).toBeGreaterThan(-1);
        return { stdout: codexStream('{"answer":"4"}'), code: 0 };
      },
    });
    const adapter = createCodexAdapter({ processRunner: fake });
    const res = await adapter.run(req({ schema }), ctx());
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().data).toEqual({ answer: "4" });
  });

  it("forwards translated progress events to ctx.onProgress without throwing", async () => {
    const fake = createFakeProcessRunner({
      codex: {
        stdout:
          JSON.stringify({ type: "turn.started", model: "gpt-5-codex" }) +
          "\n" +
          codexStream('{"answer":"4"}', { input: 1, output: 2 }),
        code: 0,
      },
    });
    const adapter = createCodexAdapter({ processRunner: fake, fileStore: createFakeFileStore() });
    const progress: unknown[] = [];
    await adapter.run(req({ schema }), { runId: "r", seq: 0, onProgress: (p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(0);
  });
});

describe("createDefaultFileStore", () => {
  it("writes a temp file, reads it back, and removes it on cleanup", async () => {
    const store = createDefaultFileStore();
    const path = await store.writeTemp("codex-schema.json", '{"hello":"world"}');
    expect(await readFile(path, "utf8")).toBe('{"hello":"world"}');
    expect(await store.read(path)).toBe('{"hello":"world"}');

    await store.cleanup([path]);
    await expect(access(path)).rejects.toBeDefined();
  });

  it("cleanup swallows errors for already-missing paths", async () => {
    const store = createDefaultFileStore();
    await expect(store.cleanup(["/tmp/does-not-exist-wf-codex.json"])).resolves.toBeUndefined();
  });
});
