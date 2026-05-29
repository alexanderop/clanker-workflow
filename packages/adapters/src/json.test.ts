import { describe, it, expect } from "vitest";
import { extractJson, compileJsonSchemaValidator } from "./json.js";

describe("extractJson", () => {
  it("pulls JSON out of a fenced code block", () => {
    expect(extractJson('text\n```json\n{"n":7}\n```\nmore')).toEqual({ n: 7 });
  });
  it("pulls bare JSON object from surrounding prose", () => {
    expect(extractJson('Sure! {"n": 8} done')).toEqual({ n: 8 });
  });
  it("returns undefined when no JSON present", () => {
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("compileJsonSchemaValidator", () => {
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false };
  it("returns null for valid data", () => {
    expect(compileJsonSchemaValidator(schema)({ n: 7 })).toBeNull();
  });
  it("returns issue strings for invalid data", () => {
    const issues = compileJsonSchemaValidator(schema)({ n: "x" });
    expect(issues).not.toBeNull();
    expect((issues ?? []).length).toBeGreaterThan(0);
  });
});
