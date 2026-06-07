import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    maxWorkers: 1,
    testTimeout: 30000,
    include: ["src/__tests__/**/*.test.ts"],
  },
});
