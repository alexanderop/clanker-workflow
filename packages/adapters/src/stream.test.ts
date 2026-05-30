import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { translateClaudeLine, extractClaudeFinal } from "./claude-stream.js";
import { translateCodexLine, extractCodexUsage, extractCodexModel } from "./codex-stream.js";
import { translateCopilotLine, extractCopilotFinal } from "./copilot-stream.js";

const read = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const lines = (text: string): string[] => text.split("\n").filter((l) => l.trim() !== "");

describe("claude StreamTranslator", () => {
  const claude = read("claude-stream.ndjson");

  it("maps init/assistant lines to model, tools, and rising tokens; skips noise", () => {
    const progress = lines(claude).flatMap(translateClaudeLine);
    expect(progress.find((p) => p.model)?.model).toBe("claude-opus-4-8[1m]");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["WebFetch", "WebFetch"]);
    expect(progress.filter((p) => typeof p.tokens === "number").map((p) => p.tokens)).toEqual([40, 80, 150]);
    // hook_started / rate_limit_event / user lines contribute nothing.
    expect(translateClaudeLine('{"type":"hook_started"}')).toEqual([]);
    expect(translateClaudeLine("not json")).toEqual([]);
  });

  it("extracts final text, data, usage and model from the result line", () => {
    const final = extractClaudeFinal(claude)._unsafeUnwrap();
    expect(final.data).toEqual({ n: 7 });
    expect(final.usage).toEqual({ inputTokens: 10406, outputTokens: 106 });
    expect(final.model).toBe("claude-opus-4-8[1m]");
  });

  it("errors when there is no result line or it reports is_error", () => {
    expect(extractClaudeFinal('{"type":"system","model":"m"}').isErr()).toBe(true);
    expect(extractClaudeFinal('{"type":"result","is_error":true}').isErr()).toBe(true);
  });
});

describe("codex StreamTranslator", () => {
  const codex = read("codex-stream.ndjson");

  it("maps init/tool/turn lines to model, tools and real usage", () => {
    const progress = lines(codex).flatMap(translateCodexLine);
    expect(progress.find((p) => p.model)?.model).toBe("gpt-5-codex");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["command_execution", "search"]);
    expect(extractCodexModel(codex)).toBe("gpt-5-codex");
    expect(extractCodexUsage(codex)).toEqual({ inputTokens: 3200, outputTokens: 18 });
  });

  it("returns null usage when no turn.completed carries usage", () => {
    expect(extractCodexUsage('{"type":"turn.started"}')).toBeNull();
  });
});

describe("copilot StreamTranslator", () => {
  const copilot = read("copilot-stream.ndjson");

  it("maps session/tool/delta lines to model, tools and tokens", () => {
    const progress = lines(copilot).flatMap(translateCopilotLine);
    expect(progress.find((p) => p.model)?.model).toBe("claude-sonnet-4-6");
    expect(progress.filter((p) => p.tool).map((p) => p.tool!.name)).toEqual(["shell"]);
    expect(progress.filter((p) => typeof p.tokens === "number").map((p) => p.tokens)).toEqual([12, 30]);
  });

  it("extracts the final text and usage from the result event", () => {
    const final = extractCopilotFinal(copilot)._unsafeUnwrap();
    expect(final.text).toBe('{"n":7}');
    expect(final.usage).toEqual({ inputTokens: 900, outputTokens: 30 });
    expect(final.model).toBe("claude-sonnet-4-6");
    expect(extractCopilotFinal('{"type":"session.created"}').isErr()).toBe(true);
  });
});
