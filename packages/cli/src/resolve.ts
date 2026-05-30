export interface ResolveDeps {
  readonly homeDir: string;
  readonly cwd: string;
  readonly readFile: (path: string) => string | undefined;
  /** Optional bundled-workflows dir (the CLI's shipped examples). Lowest precedence. */
  readonly bundledDir?: string | undefined;
}

export interface ResolvedWorkflow {
  readonly path: string;
  readonly source: string;
}

/**
 * Resolve a saved/bundled workflow by name (design §9):
 *   1. project `.workflow/workflows/` (`.ts` beats `.js`)
 *   2. personal `~/.workflow/workflows/` (`.ts` beats `.js`)
 *   3. bundled `${bundledDir}/` (`.ts` beats `.js`), when `bundledDir` is provided
 */
export function resolveSavedWorkflow(name: string, deps: ResolveDeps): ResolvedWorkflow | undefined {
  const candidates = [
    `${deps.cwd}/.workflow/workflows/${name}.ts`,
    `${deps.cwd}/.workflow/workflows/${name}.js`,
    `${deps.homeDir}/.workflow/workflows/${name}.ts`,
    `${deps.homeDir}/.workflow/workflows/${name}.js`,
    ...(deps.bundledDir
      ? [`${deps.bundledDir}/${name}.ts`, `${deps.bundledDir}/${name}.js`]
      : []),
  ];
  for (const path of candidates) {
    const source = deps.readFile(path);
    if (source !== undefined) return { path, source };
  }
  return undefined;
}
