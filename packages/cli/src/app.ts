import type { RawApiAdapterDeps, AdapterId, ProcessRunner } from "@workflow/adapters";
import type { StartUiOptions, UiHandle } from "@workflow/ui";
import type { WorkflowConfig } from "./config.js";
import type { ConsentIO } from "./consent.js";
import type { Registry } from "./registry.js";

/**
 * Everything the command layer needs from the outside world, injected so commands stay
 * testable without touching fs / spawning processes / rendering Ink. `cli.ts` builds the
 * real implementation; tests pass fakes.
 */
export interface AppDeps {
  readonly registry: Registry;
  readonly config: WorkflowConfig;
  readonly cwd: string;
  readonly homeDir: string;
  /** Base directory for ephemeral worktrees etc. */
  readonly tmpDir: string;
  readonly cores: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  readonly ci: boolean;
  readonly now: () => number;
  readonly rand: () => number;
  readonly pid: () => number;
  readonly hash: (source: string) => string;

  readonly processRunner: ProcessRunner;
  readonly complete?: RawApiAdapterDeps["complete"] | undefined;
  readonly detected: readonly AdapterId[];

  readonly readTextFile: (path: string) => string | undefined;
  readonly writeTextFile: (path: string, data: string) => void;
  readonly print: (text: string) => void;
  /** Dir holding the CLI's bundled example workflows. */
  readonly bundledDir: string;

  readonly startUi: (opts: StartUiOptions) => UiHandle;
  readonly consentIO: ConsentIO;
  readonly persistConsent: (project: string, name: string) => void;

  readonly spawnDetached: (runId: string) => number;
  readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly onSigterm: (handler: () => void) => void;
  readonly watchEvents: (runId: string, onChange: () => void) => () => void;
}
