import { describe, it, expect } from "vitest";
import { createJournal } from "./journal.js";

describe("journal", () => {
  it("returns a miss before record, a hit after, keyed by seq", () => {
    const j = createJournal();
    expect(j.lookup(0)).toBeUndefined();
    j.record({ seq: 0, key: "0:Search:a", data: { found: true }, text: "x", outputTokens: 9 });
    const hit = j.lookup(0);
    expect(hit?.data).toEqual({ found: true });
    expect(hit?.outputTokens).toBe(9);
  });

  it("serializes to and from JSONL records", () => {
    const j = createJournal();
    j.record({ seq: 0, key: "0:P:a", data: 1, text: "", outputTokens: 0 });
    j.record({ seq: 1, key: "1:P:b", data: 2, text: "", outputTokens: 0 });
    const restored = createJournal(j.entries());
    expect(restored.lookup(1)?.data).toBe(2);
  });
});
