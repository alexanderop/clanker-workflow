import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toJsonSchema } from "./index.js";
import { validate } from "./index.js";

describe("toJsonSchema", () => {
  it("converts a zod object to a JSON Schema with properties", () => {
    const schema = z.object({ title: z.string(), count: z.number() });
    const result = toJsonSchema(schema);
    expect(result.isOk()).toBe(true);
    const json = result._unsafeUnwrap();
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties as object)).toEqual(["title", "count"]);
  });
});

describe("validate", () => {
  const schema = z.object({ title: z.string() });

  it("returns Ok with typed data on valid input", () => {
    const r = validate(schema, { title: "hi" });
    expect(r.isOk()).toBe(true);
    expect(r._unsafeUnwrap()).toEqual({ title: "hi" });
  });

  it("returns Err with readable issues on invalid input", () => {
    const r = validate(schema, { title: 42 });
    expect(r.isErr()).toBe(true);
    const e = r._unsafeUnwrapErr();
    expect(e.kind).toBe("Validation");
    expect(e.kind === "Validation" && e.issues.length).toBeGreaterThan(0);
  });
});
