# Multi-Harness Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single workflow run different coding harnesses per step (e.g. Copilot drafts, Claude reviews), with a fail-fast pre-flight that validates every harness it references is installed before the run starts.

**Architecture:** The runtime already dispatches per-call harness overrides (`AgentOptions.adapter`/`ProfileConfig.adapter` → `resolveRunner` at `runtime.ts:265`). This plan (1) tightens those `adapter` fields from `string` to the `HarnessId` literal union, (2) adds a deterministic AST scanner in `@workflow/core` that collects every harness literal a script references and rejects non-literal (computed) `adapter` values, (3) adds a CLI availability check that fails fast when a referenced harness isn't installed/buildable, (4) wires it into the run command before dispatch, and (5) documents the pattern with a runnable example.

**Tech Stack:** TypeScript (strict, ESM), neverthrow `Result`, acorn (already a `@workflow/core` dep, used by `extractMeta`), esbuild `transformSync`, vitest, pnpm workspaces.

**Spec:** `docs/feature-specs/multi-harness-workflows.md`

**Before you start — read these for context:**
- `packages/core/src/sandbox.ts` — `transformScript()` (TS→JS via esbuild) and `extractMeta()` (acorn parse + AST walk). The scanner mirrors this exactly.
- `packages/cli/src/adapter-select.ts` — `resolveHarness`, `buildRunner`, `buildRunnerMap`.
- `packages/cli/src/commands/run.ts` — the run command; pre-flight goes in here (it runs before both foreground and `--detach`).
- `CLAUDE.md` → "Errors are values" (neverthrow), "Test layout & conventions" (`@workflow/test-support`, determinism, build-before-test).

**Monorepo test gotcha (from `docs/solutions/`):** run `pnpm build` before `pnpm test`, and do **not** use `pnpm --filter` to run vitest. Run a single file with `pnpm vitest run <path>` from the repo root.

---

## File Structure

- **Modify** `packages/core/src/runtime.ts` — `AgentOptions.adapter: string` → `HarnessId`.
- **Modify** `packages/core/src/profile.ts` — `ProfileConfig.adapter: string` → `HarnessId`.
- **Modify** `packages/core/src/errors.ts` — add `HarnessNotLiteral` and `HarnessUnavailable` kinds.
- **Modify** `packages/core/src/format-error.ts` — render the two new error kinds.
- **Create** `packages/core/src/harness-scan.ts` — `scanReferencedHarnesses(source): Result<readonly HarnessId[], WorkflowError>`.
- **Create** `packages/core/src/harness-scan.test.ts` — scanner unit tests.
- **Modify** `packages/core/src/index.ts` — export `scanReferencedHarnesses`.
- **Modify** `packages/cli/src/adapter-select.ts` — add `validateHarnessesAvailable(...)`.
- **Modify** `packages/cli/src/adapter-select.test.ts` — availability-check tests.
- **Modify** `packages/cli/src/commands/run.ts` — wire pre-flight scan + validation (skipped under `--mock`).
- **Modify** `packages/cli/src/commands/commands.test.ts` — run-command pre-flight tests.
- **Create** `packages/examples/src/multi-harness.workflow.ts` — runnable mixed-harness example.
- **Modify** `apps/docs/guide/index.md` — document the per-step harness pattern.

---

## Task 1: Tighten `adapter` fields to `HarnessId`

**Files:**
- Modify: `packages/core/src/runtime.ts:7` (import) and `packages/core/src/runtime.ts:31` (field)
- Modify: `packages/core/src/profile.ts:1-15`

This is a type-only change; its verification is `pnpm typecheck`. `HarnessId = "claude" | "codex" | "copilot" | "raw-api"` is already defined in `packages/core/src/types.ts:8`. The published `defineworkflow` package imports `AgentOptions`/`ProfileConfig` from `@workflow/core` (see `packages/workflow/src/index.ts:2`), so the tightening propagates automatically — no edit needed there.

- [ ] **Step 1: Add `HarnessId` to the runtime's type import**

In `packages/core/src/runtime.ts`, line 7 currently reads:

```typescript
import type { AgentRequest, AgentRunner, WorkflowMeta } from "./types.js";
```

Change it to:

```typescript
import type { AgentRequest, AgentRunner, HarnessId, WorkflowMeta } from "./types.js";
```

- [ ] **Step 2: Tighten `AgentOptions.adapter`**

In `packages/core/src/runtime.ts`, line 31 currently reads:

```typescript
  readonly adapter?: string;
```

Change it to:

```typescript
  readonly adapter?: HarnessId;
```

- [ ] **Step 3: Tighten `ProfileConfig.adapter`**

In `packages/core/src/profile.ts`, add the type import at the top of the file (the file currently has no imports — add this as line 1):

```typescript
import type { HarnessId } from "./types.js";
```

Then change the `adapter` field (currently line 9, `readonly adapter?: string;`) to:

```typescript
  readonly adapter?: HarnessId;
```

- [ ] **Step 4: Build core and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS. (If any existing example/test passes a bogus adapter string, it will now fail to compile — fix it to a real `HarnessId`.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/profile.ts
git commit -m "feat(core): tighten agent/profile adapter to HarnessId literal union"
```

---

## Task 2: Add `HarnessNotLiteral` and `HarnessUnavailable` error kinds

**Files:**
- Modify: `packages/core/src/errors.ts:4-18`
- Modify: `packages/core/src/format-error.ts:6-29`

These two kinds are consumed by Tasks 3 & 4. `formatError` uses `assertNever`, so the switch must handle every kind — adding the kinds without the `formatError` cases breaks the build. Do both together.

- [ ] **Step 1: Add the error kinds to the union**

In `packages/core/src/errors.ts`, the union currently ends with:

```typescript
  | { readonly kind: "HarnessNotDeclared"; readonly found: string | undefined }
  | { readonly kind: "UnansweredQuestion"; readonly key: string };
```

Insert the two new kinds before `UnansweredQuestion`:

```typescript
  | { readonly kind: "HarnessNotDeclared"; readonly found: string | undefined }
  | { readonly kind: "HarnessNotLiteral"; readonly expr: string }
  | { readonly kind: "HarnessUnavailable"; readonly harness: string; readonly reason: string }
  | { readonly kind: "UnansweredQuestion"; readonly key: string };
```

- [ ] **Step 2: Render them in `formatError`**

In `packages/core/src/format-error.ts`, after the `HarnessNotDeclared` case (ends at line 24) and before the `UnansweredQuestion` case, insert:

```typescript
    case "HarnessNotLiteral":
      return `HarnessNotLiteral: a per-call \`adapter\` must be a string literal (one of "claude" | "codex" | "copilot" | "raw-api"), not the expression ${JSON.stringify(error.expr)} — the engine validates harness availability before the run starts`;
    case "HarnessUnavailable":
      return `HarnessUnavailable: this workflow uses the "${error.harness}" harness but ${error.reason}`;
```

- [ ] **Step 3: Build and typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: PASS (the `assertNever` default proves the switch is exhaustive).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/format-error.ts
git commit -m "feat(core): add HarnessNotLiteral and HarnessUnavailable error kinds"
```

---

## Task 3: Build the AST harness scanner in `@workflow/core`

**Files:**
- Create: `packages/core/src/harness-scan.ts`
- Test: `packages/core/src/harness-scan.test.ts`
- Modify: `packages/core/src/index.ts:22`

The scanner reuses the exact pipeline `extractMeta` uses: `transformScript(source)` (strips TS + imports, returns plain JS) → `parse(js, …)` with acorn → recursive AST walk. It finds every object `Property` whose key is `adapter`; a string-`Literal` value is collected (and checked against the known harnesses), anything else (Identifier, CallExpression, member access, template with interpolation, etc.) is a `HarnessNotLiteral` error. Because it walks the AST, the word `adapter:` inside a prompt string is a `Literal`'s `.value`, never a `Property` key — so there are **no false positives**.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/harness-scan.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scanReferencedHarnesses } from "./harness-scan.js";

const wrap = (body: string) =>
  `import { defineWorkflow, agent, profile } from "defineworkflow";\n` +
  `export default defineWorkflow({\n` +
  `  name: "t", description: "d", harness: "claude",\n` +
  `  async run() {\n${body}\n  },\n});\n`;

describe("scanReferencedHarnesses", () => {
  it("collects literal adapter overrides from agent() options", () => {
    const r = scanReferencedHarnesses(wrap(`await agent("draft", { adapter: "copilot", model: "gpt-5" });`));
    expect(r.isOk() && r.value).toEqual(["copilot"]);
  });

  it("collects literal adapters from profile() configs", () => {
    const r = scanReferencedHarnesses(
      wrap(`const rev = profile({ adapter: "codex", model: "o4" });\nawait agent(rev, "review");`),
    );
    expect(r.isOk() && r.value).toEqual(["codex"]);
  });

  it("dedupes repeated adapters and preserves first-seen order", () => {
    const r = scanReferencedHarnesses(
      wrap(`await agent("a", { adapter: "copilot" });\nawait agent("b", { adapter: "claude" });\nawait agent("c", { adapter: "copilot" });`),
    );
    expect(r.isOk() && r.value).toEqual(["copilot", "claude"]);
  });

  it("returns an empty set when no adapter override is present", () => {
    const r = scanReferencedHarnesses(wrap(`await agent("just the default harness");`));
    expect(r.isOk() && r.value).toEqual([]);
  });

  it("does NOT treat the word 'adapter:' inside a prompt string as a reference", () => {
    const r = scanReferencedHarnesses(wrap(`await agent("explain the adapter: pattern in TS");`));
    expect(r.isOk() && r.value).toEqual([]);
  });

  it("errors HarnessNotLiteral on a computed adapter value", () => {
    const r = scanReferencedHarnesses(wrap(`const h = "copilot";\nawait agent("x", { adapter: h });`));
    expect(r.isErr() && r.error.kind).toBe("HarnessNotLiteral");
  });

  it("errors HarnessNotDeclared on an unknown harness literal", () => {
    const r = scanReferencedHarnesses(wrap(`await agent("x", { adapter: "gpt4cli" });`));
    expect(r.isErr() && r.error.kind).toBe("HarnessNotDeclared");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/harness-scan.test.ts`
Expected: FAIL — `Cannot find module './harness-scan.js'`.

- [ ] **Step 3: Implement the scanner**

Create `packages/core/src/harness-scan.ts`:

```typescript
import { parse } from "acorn";
import { ok, err, type Result } from "neverthrow";
import { transformScript } from "./sandbox.js";
import type { WorkflowError } from "./errors.js";
import type { HarnessId } from "./types.js";

const KNOWN: readonly HarnessId[] = ["claude", "codex", "copilot", "raw-api"];

// Loose AST node shape — we only ever read a handful of fields (mirrors sandbox.ts).
type AstNode = { type: string; [key: string]: unknown };

/**
 * Statically collect every coding harness a workflow references via a per-call `adapter`
 * override (`agent("p", { adapter })` or `profile({ adapter })`). Reuses the same
 * transform+parse pipeline as {@link extractMeta}, so it sees real AST `Property` nodes — the
 * word "adapter:" inside a prompt string is a Literal value, never a key, so it is ignored.
 *
 * Per the design, a per-call `adapter` must be a **string literal**: a computed expression
 * (`adapter: someVar`) yields `HarnessNotLiteral` so the run can fail fast instead of
 * silently falling back to the default harness. The returned set does NOT include
 * `meta.harness` — the caller unions that in.
 */
export function scanReferencedHarnesses(source: string): Result<readonly HarnessId[], WorkflowError> {
  let program: AstNode;
  try {
    const js = transformScript(source);
    program = parse(js, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AstNode;
  } catch (e) {
    // A parse/transform failure here is not the scanner's concern — extractMeta/runInSandbox
    // surface script errors. Treat an unparseable script as "no overrides found".
    return ok([]);
  }

  const found: HarnessId[] = [];
  const seen = new Set<string>();
  let failure: WorkflowError | undefined;

  const visit = (node: unknown): void => {
    if (failure || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as AstNode;
    if (n.type === "Property" && !(n.computed as boolean) && isAdapterKey(n.key as AstNode)) {
      const value = n.value as AstNode;
      if (value.type === "Literal" && typeof value.value === "string") {
        const lit = value.value;
        if (!KNOWN.includes(lit as HarnessId)) {
          failure = { kind: "HarnessNotDeclared", found: lit };
          return;
        }
        if (!seen.has(lit)) {
          seen.add(lit);
          found.push(lit as HarnessId);
        }
      } else {
        failure = { kind: "HarnessNotLiteral", expr: describe(value) };
        return;
      }
    }
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end") continue;
      visit(n[key]);
    }
  };

  visit(program);
  return failure ? err(failure) : ok(found);
}

function isAdapterKey(key: AstNode): boolean {
  return (
    (key.type === "Identifier" && key.name === "adapter") ||
    (key.type === "Literal" && key.value === "adapter")
  );
}

/** A short, safe description of a non-literal value node for the error message. */
function describe(node: AstNode): string {
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "MemberExpression") return "<member expression>";
  if (node.type === "CallExpression") return "<function call>";
  if (node.type === "TemplateLiteral") return "<template literal>";
  return `<${node.type}>`;
}
```

- [ ] **Step 4: Export the scanner from the core barrel**

In `packages/core/src/index.ts`, line 22 currently reads:

```typescript
export { runInSandbox, extractMeta, transformScript, type SandboxResult } from "./sandbox.js";
```

Add a new export line after it:

```typescript
export { scanReferencedHarnesses } from "./harness-scan.js";
```

- [ ] **Step 5: Build, then run the tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/core/src/harness-scan.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/harness-scan.ts packages/core/src/harness-scan.test.ts packages/core/src/index.ts
git commit -m "feat(core): add scanReferencedHarnesses AST scanner with literal enforcement"
```

---

## Task 4: Add `validateHarnessesAvailable` to the CLI adapter selector

**Files:**
- Modify: `packages/cli/src/adapter-select.ts`
- Test: `packages/cli/src/adapter-select.test.ts`

Availability (which CLIs are on PATH, whether raw-api has a key) is a CLI/adapters concern, so the check lives here, not in core. `detected` is the list of installed CLI ids (`deps.adapters.detected`, see `app.ts:38`). `raw-api` has no binary — it is "available" only when a completion fn is configured (`deps.complete`, same gate `buildRunner` uses at `adapter-select.ts:46`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/src/adapter-select.test.ts` (append inside the file; reuse its existing imports — add `validateHarnessesAvailable` to the import from `./adapter-select.js`, and a `WorkflowConfig` value `{}` cast as needed):

```typescript
describe("validateHarnessesAvailable", () => {
  const cfg = {} as WorkflowConfig;
  const deps = { processRunner: {} as ProcessRunner };

  it("passes when every referenced CLI harness is detected", () => {
    const r = validateHarnessesAvailable(["claude", "copilot"], ["claude", "copilot", "codex"], cfg, deps);
    expect(r.isOk()).toBe(true);
  });

  it("fails HarnessUnavailable when a referenced CLI is not installed", () => {
    const r = validateHarnessesAvailable(["claude", "copilot"], ["claude"], cfg, deps);
    expect(r.isErr() && r.error.kind).toBe("HarnessUnavailable");
    expect(r.isErr() && (r.error as { harness: string }).harness).toBe("copilot");
  });

  it("treats raw-api as available only when a completion fn is configured", () => {
    const withKey = validateHarnessesAvailable(["raw-api"], [], cfg, { ...deps, complete: async () => ({}) as never });
    expect(withKey.isOk()).toBe(true);
    const noKey = validateHarnessesAvailable(["raw-api"], [], cfg, deps);
    expect(noKey.isErr() && noKey.error.kind).toBe("HarnessUnavailable");
  });
});
```

If `WorkflowConfig`, `ProcessRunner`, or `describe`/`expect` aren't already imported in this test file, add them (`import type { WorkflowConfig } from "./config.js";`, `import type { ProcessRunner } from "@workflow/adapters";`, and the vitest imports).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/adapter-select.test.ts`
Expected: FAIL — `validateHarnessesAvailable is not a function` / not exported.

- [ ] **Step 3: Implement `validateHarnessesAvailable`**

In `packages/cli/src/adapter-select.ts`, add this function (after `buildRunner`, before `RunnerMap`). It reuses the existing `AdapterId`, `BuildRunnerDeps`, `WorkflowConfig` types already imported in the file:

```typescript
/**
 * Fail-fast pre-flight: every harness a workflow references (its `meta.harness` default unioned
 * with the per-call `adapter` overrides found by {@link scanReferencedHarnesses}) must be runnable
 * before the first agent starts — otherwise an unavailable per-call adapter would silently fall
 * back to the default harness at `runtime.ts`'s `resolveRunner` call. CLI harnesses must be on
 * PATH (`detected`); `raw-api` needs a completion fn configured.
 */
export function validateHarnessesAvailable(
  harnesses: readonly AdapterId[],
  detected: readonly AdapterId[],
  cfg: WorkflowConfig,
  deps: BuildRunnerDeps,
): Result<void, WorkflowError> {
  for (const id of harnesses) {
    if (id === "raw-api") {
      if (!deps.complete) {
        return err({ kind: "HarnessUnavailable", harness: id, reason: "no completion function is configured (set ANTHROPIC_API_KEY or pick a CLI harness)" });
      }
      continue;
    }
    if (!detected.includes(id)) {
      return err({ kind: "HarnessUnavailable", harness: id, reason: `its CLI was not found on PATH (install it, or change the harness)` });
    }
  }
  return ok(undefined);
}
```

- [ ] **Step 4: Build, then run the tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/cli/src/adapter-select.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/adapter-select.ts packages/cli/src/adapter-select.test.ts
git commit -m "feat(cli): add validateHarnessesAvailable pre-flight check"
```

---

## Task 5: Wire the pre-flight scan + validation into the run command

**Files:**
- Modify: `packages/cli/src/commands/run.ts`
- Test: `packages/cli/src/commands/commands.test.ts`

The pre-flight runs after `resolveHarness(meta.harness)` (so we have the default `AdapterId`) and before building the runner / the `--detach` branch, so **both** foreground and detached runs are gated by one check in the parent process. It is skipped under `--mock` (mock resolves every adapter to the fabricating runner, so nothing real is spawned — consistent with how `--mock` already skips consent and the install check).

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/src/commands/commands.test.ts`. Use the existing `fakeDeps` helper from `../test-support.js` (capability-grouped `AppDeps`; override `adapters.detected` and `io.readText`). Mirror the style of the existing run-command tests in this file (find one that calls `runCommand` to copy its setup).

```typescript
describe("runCommand multi-harness pre-flight", () => {
  const script = `import { defineWorkflow, agent } from "defineworkflow";
export default defineWorkflow({
  name: "mh", description: "d", harness: "claude",
  async run() { await agent("draft", { adapter: "copilot" }); },
});`;

  it("fails fast when a per-call harness is not installed", async () => {
    const printed: string[] = [];
    const deps = fakeDeps({
      io: { readText: () => script },
      adapters: { detected: ["claude"] }, // copilot missing
      ui: { print: (s: string) => void printed.push(s) },
      env: { isTTY: false, ci: true }, // auto-consent, no prompt
    });
    const code = await runCommand({ script: "mh.ts", detach: false, yes: true }, deps);
    expect(code).toBe(1);
    expect(printed.join("")).toMatch(/HarnessUnavailable.*copilot/);
  });

  it("does not run the pre-flight under --mock", async () => {
    const deps = fakeDeps({
      io: { readText: () => script },
      adapters: { detected: ["claude"] }, // copilot still missing
      env: { isTTY: false, ci: true },
    });
    const code = await runCommand({ script: "mh.ts", detach: false, yes: true, mock: true }, deps);
    expect(code).toBe(0);
  });
});
```

Adjust the exact `fakeDeps` override shape to match the helper in `packages/cli/src/test-support.ts` and the `RunArgs` fields the existing tests pass. If a sibling test already constructs a passing foreground `runCommand`, copy its `deps` and only change `detected`/`script`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/cli/src/commands/commands.test.ts -t "pre-flight"`
Expected: FAIL — the unavailable-copilot run currently returns 0 (silent fallback) instead of 1.

- [ ] **Step 3: Add the imports to run.ts**

In `packages/cli/src/commands/run.ts`, update the imports:

- Add `scanReferencedHarnesses` to the `@workflow/core` import (currently `import { createMockRunner } from "@workflow/core";`):

```typescript
import { createMockRunner, scanReferencedHarnesses } from "@workflow/core";
```

- Add `validateHarnessesAvailable` to the `../adapter-select.js` import (currently `import { resolveHarness, buildRunner } from "../adapter-select.js";`):

```typescript
import { resolveHarness, buildRunner, validateHarnessesAvailable } from "../adapter-select.js";
```

- [ ] **Step 4: Insert the pre-flight after `resolveHarness`**

In `packages/cli/src/commands/run.ts`, locate the block that ends with `const adapter: AdapterId = harnessResult.value;` (around line 84). Immediately after that line, insert:

```typescript
  // Fail-fast pre-flight for multi-harness runs: every harness this workflow references
  // (the meta.harness default + per-call `adapter` overrides) must be runnable before the
  // first agent starts, so an unavailable override never silently falls back to the default.
  // --mock resolves every adapter to the fabricating runner, so there is nothing to validate.
  if (!args.mock) {
    const scanned = scanReferencedHarnesses(source);
    if (scanned.isErr()) {
      deps.ui.print(`error: ${formatError(scanned.error)}\n`);
      return 1;
    }
    const referenced = [...new Set<AdapterId>([adapter, ...scanned.value])];
    const availability = validateHarnessesAvailable(referenced, deps.adapters.detected, deps.config, {
      processRunner: deps.adapters.processRunner,
      complete: deps.adapters.complete,
    });
    if (availability.isErr()) {
      deps.ui.print(`error: ${formatError(availability.error)}\n`);
      return 1;
    }
  }
```

`formatError` is already imported in `run.ts`; `AdapterId` is already imported from `@workflow/adapters`.

- [ ] **Step 5: Build, then run the tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/cli/src/commands/commands.test.ts -t "pre-flight"`
Expected: PASS (both tests).

- [ ] **Step 6: Run the full unit suite to check for regressions**

Run: `pnpm test`
Expected: PASS (no regressions in run/consent/execute tests).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/run.ts packages/cli/src/commands/commands.test.ts
git commit -m "feat(cli): fail-fast pre-flight validation of per-step harnesses"
```

---

## Task 6: Add a runnable multi-harness example

**Files:**
- Create: `packages/examples/src/multi-harness.workflow.ts`

The example mixes harnesses in one workflow: `meta.harness: "claude"` is the default; one step overrides to `copilot` via a `profile`, another uses a per-call `adapter`. It is a real `defineWorkflow` file, validated by `pnpm typecheck` (the example package is type-checked). It is not run in CI (it would spawn real agents).

- [ ] **Step 1: Create the example**

Create `packages/examples/src/multi-harness.workflow.ts`:

```typescript
import { defineWorkflow, agent, profile, z } from "defineworkflow";

// Copilot drafts, Claude reviews — two harnesses in one run.
// meta.harness is the default; per-call `adapter` overrides it for that step.
const drafter = profile({ adapter: "copilot", model: "gpt-5" });

export default defineWorkflow({
  name: "multi-harness",
  description: "Copilot drafts a function, Claude Code reviews it — mixing harnesses per step.",
  harness: "claude",
  phases: [
    { title: "Draft", detail: "Copilot writes a first version" },
    { title: "Review", detail: "Claude reviews and rates it" },
  ],
  async run() {
    phase("Draft");
    const draft = await agent(drafter, "Write a TypeScript function `slugify(s: string): string`. Return only the code.");

    phase("Review");
    const review = await agent(
      `Review this implementation and rate it 1-5:\n\n${draft}`,
      { adapter: "claude", model: "sonnet", schema: z.object({ rating: z.number(), notes: z.string() }) },
    );

    return { draft, review };
  },
});
```

- [ ] **Step 2: Typecheck the examples package**

Run: `pnpm build && pnpm typecheck`
Expected: PASS — `adapter: "copilot"` / `"claude"` are valid `HarnessId`s; a typo like `"copilott"` would now be a compile error (Task 1).

- [ ] **Step 3: Smoke-test the control flow with --mock (no agents, no tokens)**

Run: `node packages/cli/dist/cli.js run packages/examples/src/multi-harness.workflow.ts --mock --yes`
Expected: the run completes, prints a returned object with `draft` and `review` keys, and spawns no real agent. (`--mock` skips the harness pre-flight, so it works even if copilot isn't installed.)

- [ ] **Step 4: Commit**

```bash
git add packages/examples/src/multi-harness.workflow.ts
git commit -m "docs(examples): add multi-harness workflow example"
```

---

## Task 7: Document the per-step harness pattern

**Files:**
- Modify: `apps/docs/guide/index.md`

- [ ] **Step 1: Add a "Mixing harnesses" section**

Append to `apps/docs/guide/index.md` (place it after the section that introduces `meta.harness`; adjust heading level to match surrounding headings):

````markdown
## Mixing harnesses in one workflow

`meta.harness` is the **run default**, not a hard constraint. Any `agent()` call can run on a
different harness (and model) by passing `adapter` and `model`:

```ts
// Default harness is "claude" (meta.harness); this step runs on Copilot instead.
const draft = await agent("draft a slugify()", { adapter: "copilot", model: "gpt-5" });
const review = await agent(`review:\n${draft}`, { adapter: "claude", model: "sonnet" });
```

Reuse a harness+model as a **profile**:

```ts
const drafter = profile({ adapter: "copilot", model: "gpt-5" });
await agent(drafter, "draft a slugify()");
```

The `adapter` must be a **string literal** (`"claude" | "codex" | "copilot" | "raw-api"`), not a
variable — the engine statically scans your workflow for every harness it references and
**fails fast before the run starts** if any of them isn't installed (or, for `raw-api`, if no
`ANTHROPIC_API_KEY` is configured). This means an unavailable harness is caught up front instead
of silently falling back to the default. `--mock` skips this check, since it spawns no real agents.

See `packages/examples/src/multi-harness.workflow.ts` for a complete example.
````

- [ ] **Step 2: Commit**

```bash
git add apps/docs/guide/index.md
git commit -m "docs: document mixing harnesses per step"
```

---

## Final Verification

- [ ] **Step 1: Full build + typecheck + lint + tests**

Run: `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

- [ ] **Step 2: Manual fail-fast check (real, not mock)**

Run (with copilot NOT installed): `node packages/cli/dist/cli.js run packages/examples/src/multi-harness.workflow.ts --yes`
Expected: exits non-zero, prints `error: HarnessUnavailable: this workflow uses the "copilot" harness but its CLI was not found on PATH …` — before any agent runs.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- "Default + override" → Task 1 (types) + existing runtime dispatch (no change needed). ✓
- "Auto-discovery via literal scan" + "require literal harness strings" → Task 3 (`scanReferencedHarnesses`, `HarnessNotLiteral`). ✓
- "Fail-fast pre-flight" → Task 4 (`validateHarnessesAvailable`) + Task 5 (wiring). ✓
- "Model is pass-through" → unchanged; explicitly not validated. ✓ (no task needed)
- "`--mock` skips pre-flight" → Task 5 Step 4 guard + Task 6 Step 3. ✓
- "raw-api needs a key" → Task 4 Step 3 raw-api branch. ✓
- "Docs + runnable example" → Tasks 6 & 7. ✓
- Determinism / replay unaffected → no change to seq/journal; harness choice is fixed by the literal script. ✓

**Type consistency:** `HarnessId` (core/types.ts) === `AdapterId` (adapters/detect.ts) string-wise; `scanReferencedHarnesses` returns `HarnessId[]`, `validateHarnessesAvailable` takes `AdapterId[]` — the union in Task 5 (`new Set<AdapterId>([adapter, ...scanned.value])`) is sound because the literal members are identical. Error kinds `HarnessNotLiteral`/`HarnessUnavailable` are defined in Task 2 before first use in Tasks 3–5. `formatError` handles both (Task 2).

**Placeholder scan:** every code step contains complete code; commands have expected output. No TBDs.

## Status

**Status:** Plan Complete
**Created:** 2026-05-30
**Spec:** `docs/feature-specs/multi-harness-workflows.md`
