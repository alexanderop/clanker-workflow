import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type AdapterId = "claude" | "codex" | "copilot" | "raw-api";

export interface Capabilities {
  readonly nativeSchema: boolean;
  readonly reportsTokens: boolean;
  readonly toolEvents: boolean;
}

export const CAPABILITIES: Readonly<Record<AdapterId, Capabilities>> = {
  claude: { nativeSchema: true, reportsTokens: true, toolEvents: false },
  codex: { nativeSchema: true, reportsTokens: false, toolEvents: false },
  copilot: { nativeSchema: false, reportsTokens: false, toolEvents: false },
  "raw-api": { nativeSchema: true, reportsTokens: true, toolEvents: false },
};

const CLI_BINS: Readonly<Record<string, string>> = { claude: "claude", codex: "codex", copilot: "copilot" };

async function binExists(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      // not here; keep looking
    }
  }
  return false;
}

export interface DetectDeps {
  readonly exists?: (bin: string) => Promise<boolean>;
}

/** Returns the CLI adapter ids whose binary is on PATH. `raw-api` is always available (no binary). */
export async function detectAdapters(deps: DetectDeps = {}): Promise<readonly AdapterId[]> {
  const exists = deps.exists ?? binExists;
  const found: AdapterId[] = [];
  for (const [id, bin] of Object.entries(CLI_BINS)) {
    if (await exists(bin)) found.push(id as AdapterId);
  }
  return found;
}
