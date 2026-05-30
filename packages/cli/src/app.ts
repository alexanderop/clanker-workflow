import type { RawApiAdapterDeps, AdapterId, ProcessRunner } from "@workflow/adapters";
import type { StartUiOptions, UiHandle } from "@workflow/ui";
import type { WorkflowConfig } from "./config.js";
import type { ConsentIO } from "./consent.js";
import type { Registry } from "./registry.js";

/** Deterministic leaf primitives — the only source of "now"/randomness/identity in the CLI. */
export interface Clock {
  now(): number;
  rand(): number;
  pid(): number;
  hash(source: string): string;
}

/** Ambient environment: paths, process env, and the TTY/CI shape of the host. */
export interface Env {
  readonly cwd: string;
  readonly homeDir: string;
  /** Base directory for ephemeral worktrees etc. */
  readonly tmpDir: string;
  /** Dir holding the CLI's bundled example workflows. */
  readonly bundledDir: string;
  readonly cores: number;
  readonly vars: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  readonly ci: boolean;
}

/** Plain text file read/write (distinct from the registry's structured fs). */
export interface FileIO {
  readText(path: string): string | undefined;
  writeText(path: string, data: string): void;
}

/** Harness resolution inputs: how to spawn CLIs, which are present, and the raw-api completer. */
export interface AdapterDeps {
  readonly processRunner: ProcessRunner;
  readonly detected: readonly AdapterId[];
  readonly complete?: RawApiAdapterDeps["complete"] | undefined;
}

/** Terminal output: the Ink dashboard and raw stdout writes. */
export interface UiDeps {
  start(opts: StartUiOptions): UiHandle;
  print(text: string): void;
}

/** Interactive consent prompt + its persistence. */
export interface ConsentDeps {
  io: ConsentIO;
  persist(project: string, name: string): void;
}

/** Host process & run lifecycle control (detached children, signals, log watching). */
export interface ProcessControl {
  spawnDetached(runId: string): number;
  kill(pid: number, signal: NodeJS.Signals): void;
  onSigterm(handler: () => void): void;
  watchEvents(runId: string, onChange: () => void): () => void;
}

/**
 * Everything the command layer needs from the outside world, injected so commands stay
 * testable without touching fs / spawning processes / rendering Ink. `cli.ts` builds the
 * real implementation; tests pass fakes. Fields are grouped into capability roles so each
 * command can declare exactly the slice it needs via `Pick<AppDeps, ...>`.
 */
export interface AppDeps {
  readonly registry: Registry;
  readonly config: WorkflowConfig;
  readonly clock: Clock;
  readonly env: Env;
  readonly io: FileIO;
  readonly adapters: AdapterDeps;
  readonly ui: UiDeps;
  readonly consent: ConsentDeps;
  readonly proc: ProcessControl;
}
