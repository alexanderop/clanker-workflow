import Ajv from "ajv";
import type { Validator } from "./coercion.js";

/** Extract a JSON value from CLI text: prefer a ```json fenced block, else the first balanced {...} or [...]. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return undefined;
  for (let end = candidate.length; end > start; end--) {
    const slice = candidate.slice(start, end);
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      // shrink the window and retry
    }
  }
  return undefined;
}

/** Compile a JSON Schema into the `Validator` shape the coercion loop expects. */
export function compileJsonSchemaValidator(schema: Record<string, unknown>): Validator {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateFn = ajv.compile(schema);
  return (data: unknown): readonly string[] | null => {
    if (data === undefined) return ["no JSON value found in output"];
    const valid = validateFn(data);
    if (valid) return null;
    return (validateFn.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);
  };
}
