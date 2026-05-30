import { describe, it, expect } from "vitest";
import { createAnthropicComplete } from "./anthropic.js";

describe("createAnthropicComplete", () => {
  it("returns undefined when no API key is configured", () => {
    expect(createAnthropicComplete(undefined)).toBeUndefined();
    expect(createAnthropicComplete("")).toBeUndefined();
  });

  it("returns a completion function when an API key is present", () => {
    const complete = createAnthropicComplete("sk-test");
    expect(typeof complete).toBe("function");
  });
});
