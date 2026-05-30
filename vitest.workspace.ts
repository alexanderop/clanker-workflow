import { defineWorkspace } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

// Map the @workflow/* (and defineworkflow) specifiers straight to their
// TypeScript sources. The workspace packages are not symlinked into node_modules
// in a way Vite resolves here, and pointing at src (rather than the built dist)
// means cross-package imports execute the real source — so v8 coverage is
// attributed to the source files instead of the compiled bundles.
const workspaceAlias = {
  "@workflow/core": pkg("./packages/core/src/index.ts"),
  "@workflow/schema": pkg("./packages/schema/src/index.ts"),
  "@workflow/adapters": pkg("./packages/adapters/src/index.ts"),
  "@workflow/ui": pkg("./packages/ui/src/index.ts"),
  "@workflow/cli": pkg("./packages/cli/src/index.ts"),
  defineworkflow: pkg("./packages/workflow/src/index.ts"),
};

export default defineWorkspace([
  {
    resolve: { alias: workspaceAlias },
    test: {
      name: "unit",
      include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
      exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
    },
  },
  {
    resolve: { alias: workspaceAlias },
    test: {
      name: "e2e",
      include: ["packages/*/src/**/*.e2e.test.ts"],
    },
  },
]);
