export * from "./process-runner.js";
export { createFakeProcessRunner, type FakeProcessRunner, type FakeResponse } from "./fake-process-runner.js";
export { runWithSchemaRetry, type Attempt, type CoercionSpec, type CoercedResult, type Validator } from "./coercion.js";
export { CAPABILITIES, detectAdapters, type AdapterId, type Capabilities } from "./detect.js";
export { createClaudeAdapter, type ClaudeAdapterDeps } from "./claude.js";
export { createCodexAdapter, createDefaultFileStore, type CodexAdapterDeps, type FileStore } from "./codex.js";
export { createCopilotAdapter, type CopilotAdapterDeps } from "./copilot.js";
export { createRawApiAdapter, type RawApiAdapterDeps, type CompletionRequest, type CompletionResult } from "./raw-api.js";
export { createGenericAdapter, type GenericAdapterConfig, type GenericAdapterDeps } from "./generic.js";
export { extractJson, compileJsonSchemaValidator } from "./json.js";
export { type StreamFinal, type StreamTranslator } from "./stream.js";
export { translateClaudeLine, extractClaudeFinal } from "./claude-stream.js";
export { translateCodexLine, extractCodexUsage, extractCodexModel } from "./codex-stream.js";
export { translateCopilotLine, extractCopilotFinal, type CopilotFinal } from "./copilot-stream.js";

import type { AgentRunner } from "@workflow/core";
import type { ProcessRunner } from "./process-runner.js";
import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import { createCopilotAdapter } from "./copilot.js";

/** Build a built-in CLI adapter by id (claude/codex/copilot). raw-api and generic are constructed directly. */
export function createAdapter(
  id: "claude" | "codex" | "copilot",
  deps: { processRunner: ProcessRunner; maxRetries?: number },
): AgentRunner {
  switch (id) {
    case "claude":
      return createClaudeAdapter(deps);
    case "codex":
      return createCodexAdapter(deps);
    case "copilot":
      return createCopilotAdapter(deps);
  }
}
