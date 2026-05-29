import { z } from "zod";
import { ok, err, type Result } from "neverthrow";

export type JsonSchema = Record<string, unknown>;

export type SchemaError =
  | { readonly kind: "Conversion"; readonly cause: string }
  | { readonly kind: "Validation"; readonly issues: readonly string[] };

export function toJsonSchema(schema: z.ZodType): Result<JsonSchema, SchemaError> {
  try {
    return ok(z.toJSONSchema(schema) as JsonSchema);
  } catch (e) {
    return err({ kind: "Conversion", cause: e instanceof Error ? e.message : String(e) });
  }
}

export function validate<T>(schema: z.ZodType<T>, value: unknown): Result<T, SchemaError> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err({
    kind: "Validation",
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}
