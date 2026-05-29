import vm from "node:vm";
import { transformSync } from "esbuild";

export interface SandboxResult {
  readonly meta: { readonly name: string; readonly description: string; readonly phases?: readonly unknown[] };
  readonly returnValue: unknown;
}

/**
 * Transform a workflow script into a runnable async IIFE.
 * - `export const meta = …` becomes a plain `const meta = …`, captured after assignment
 * - the trailing top-level `return` is valid because the body runs inside an async arrow
 * - TS is stripped by esbuild
 */
export function transformScript(source: string): string {
  if (!/export\s+const\s+meta\s*=/.test(source)) {
    throw new Error("SandboxViolation: workflow script must export `const meta`");
  }
  // Declare `const meta` (so the script body can reference it) AND mirror the same
  // value onto a global for extraction — without needing to locate the end of the
  // meta literal. Robust to multi-line literals, `as const`, semicolons inside
  // strings, and a missing trailing semicolon.
  const safe = source.replace(/export\s+const\s+meta\s*=\s*/, "const meta = globalThis.__meta = ");
  const wrapped = `(async () => {\n${safe}\n})()`;
  return transformSync(wrapped, { loader: "ts", format: "esm" }).code;
}

function makeBannedDate(): typeof Date {
  const RealDate = Date;
  const Banned = function (this: unknown, ...args: unknown[]) {
    if (args.length === 0) {
      throw new Error("SandboxViolation: argless new Date() is not allowed in a workflow");
    }
    // @ts-expect-error forwarding constructor args
    return new RealDate(...args);
  } as unknown as typeof Date;
  Banned.now = () => {
    throw new Error("SandboxViolation: Date.now() is not allowed in a workflow");
  };
  Banned.parse = RealDate.parse;
  Banned.UTC = RealDate.UTC;
  return Banned;
}

export async function runInSandbox(
  source: string,
  globals: Record<string, unknown>,
): Promise<SandboxResult> {
  const js = transformScript(source);

  const bannedMath = {
    ...Math,
    random: () => {
      throw new Error("SandboxViolation: Math.random() is not allowed in a workflow");
    },
  };

  const sandbox: Record<string, unknown> = {
    ...globals,
    Math: bannedMath,
    Date: makeBannedDate(),
    __meta: undefined,
    Promise,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Error,
    console,
  };

  const context = vm.createContext(sandbox);
  const script = new vm.Script(js, { filename: "workflow.js" });
  const returnValue = await script.runInContext(context);

  const meta = sandbox.__meta as SandboxResult["meta"] | undefined;
  if (!meta) {
    throw new Error("SandboxViolation: workflow script must export `const meta`");
  }
  return { meta, returnValue };
}
