import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    // Coverage is a global-only option: per the Vitest docs it must live in
    // this root config and is ignored if set on a workspace project entry.
    coverage: {
      provider: "v8",
      // Cover every package's source, including files no test imported, so the
      // per-package numbers reflect real surface area rather than just hit files.
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "packages/*/src/**/*.test.{ts,tsx}",
        "packages/*/src/**/*.e2e.test.ts",
        "packages/*/src/**/*.d.ts",
        "**/dist/**",
        "repos/**",
        // Runnable example workflows: they orchestrate real agents and are
        // exercised end-to-end (`pnpm example` / e2e), not by unit tests.
        "packages/examples/**",
        // Executable bin entrypoints: shebang scripts with top-level await and
        // process.exit. Their behavior is the CLI itself, covered via dispatch()
        // tests and e2e; nothing unit-assertable lives in the wrapper.
        "**/packages/*/src/cli.ts",
        // The CLI package barrel — pure `export … from` re-exports, no logic.
        "**/packages/cli/src/index.ts",
        // Host composition root: wires real fs/process/Ink/SDK into AppDeps.
        // Testing it would mean mocking the entire OS; the pieces it assembles
        // are unit-tested individually.
        "**/packages/cli/src/node-deps.ts",
        // Optional-SDK IO boundary: lazily imports @anthropic-ai/sdk and makes a
        // live API call. The key-gating logic is unit-tested; the request body
        // needs the real SDK + network and is covered by e2e, not unit tests.
        "**/packages/cli/src/anthropic.ts",
        // Type-only modules (interfaces/types, zero emitted runtime code).
        "**/packages/cli/src/app.ts",
        "**/packages/core/src/types.ts",
      ],
      // text  -> per-file terminal table, grouped by package directory
      // html  -> ./coverage/index.html, drillable per package
      // json-summary + lcov -> CI gates / external tooling
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // Per-package thresholds: a glob key sets its own gate and does NOT
      // inherit the global numbers. Raise these per package as coverage grows.
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
