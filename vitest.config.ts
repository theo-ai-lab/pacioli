import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
      // Tests always exercise the workspace SOURCE, never a stale dist build.
      "@pacioli-app/engine": `${import.meta.dirname}/packages/engine/src/index.ts`,
    },
  },
  test: {
    environment: "node",
    include: [
      "lib/**/*.test.ts",
      "mcp/**/*.test.ts",
      "app/**/*.test.ts",
      "agent/**/*.test.ts",
      "scripts/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      // The capture kit is deliberately zero-dep plain-node .mjs; its tests match.
      "dataset/**/*.test.mjs",
    ],
  },
});
