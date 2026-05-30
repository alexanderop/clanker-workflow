/**
 * `@workflow/test-support` — shared, deterministic test helpers for the monorepo.
 *
 * Re-exports the engine's reusable fakes so tests have one import path, and adds leaf
 * data factories (see `factories.ts`). Private package — never published, never imported
 * by production code.
 */

// Reusable runtime fakes (already deterministic).
export { createScriptedRunner, createMockRunner, mockFromSchema } from "@workflow/core";
export type { ScriptedRunner, ScriptedResponse, MockRunnerOptions } from "@workflow/core";
export { createFakeProcessRunner } from "@workflow/adapters";
export type { FakeProcessRunner, FakeResponse } from "@workflow/adapters";

// Leaf data factories.
export * from "./factories.js";
