import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"],
      exclude: ["**/*.e2e.test.ts"],
    },
  },
  {
    test: {
      name: "e2e",
      include: ["packages/*/src/**/*.e2e.test.ts"],
    },
  },
]);
