import type { WorkflowEvent } from "@workflow/core";

export function lineLogLine(event: WorkflowEvent): string | null {
  switch (event.type) {
    case "run-started":
      return `▶ ${event.name} (${event.runId})`;
    case "phase-started":
      return `# ${event.phase}`;
    case "agent-started":
      return `  … ${event.key}`;
    case "agent-finished":
      return `  ✓ ${event.key} (${event.usage.outputTokens} tok${event.cached ? ", cached" : ""})`;
    case "agent-failed":
      return `  ✗ ${event.key} [${event.error.kind}]`;
    case "log":
      return `  ${event.message}`;
    case "run-finished":
      return "■ done";
    case "agent-queued":
    case "agent-output":
    case "agent-tool":
      return null;
  }
}
