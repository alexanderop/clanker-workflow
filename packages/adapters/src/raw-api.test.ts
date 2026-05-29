import { describe, it, expect } from "vitest";
import { createRawApiAdapter } from "./raw-api.js";

describe("raw-api adapter", () => {
  it("delegates to the injected completion fn and returns validated data + exact usage", async () => {
    const adapter = createRawApiAdapter({
      complete: async (req) => {
        expect(req.prompt).toBe("give n");
        return { text: '{"n":7}', data: { n: 7 }, usage: { inputTokens: 10, outputTokens: 4 } };
      },
    });
    expect(adapter.id).toBe("raw-api");
    expect(adapter.capabilities.reportsTokens).toBe(true);
    const res = await adapter.run(
      { prompt: "give n", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, cwd: "/tmp", signal: new AbortController().signal },
      { runId: "r", seq: 0 },
    );
    expect(res._unsafeUnwrap().data).toEqual({ n: 7 });
    expect(res._unsafeUnwrap().usage.outputTokens).toBe(4);
  });

  it("maps a thrown completion error to AdapterSpawn", async () => {
    const adapter = createRawApiAdapter({ complete: async () => { throw new Error("no api key"); } });
    const res = await adapter.run({ prompt: "x", cwd: "/tmp", signal: new AbortController().signal }, { runId: "r", seq: 0 });
    expect(res._unsafeUnwrapErr().kind).toBe("AdapterSpawn");
  });
});
