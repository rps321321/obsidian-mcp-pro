import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /(?:^|\/)lib\/embedding-store\.js$/,
        replacement: fileURLToPath(
          new URL(
            "./src/__tests__/embedding-store-legacy-adapter.ts",
            import.meta.url
          )
        ),
      },
    ],
  },
  test: {
    globals: true,
    maxWorkers: 1,
    testTimeout: 30000,
    include: ["src/__tests__/**/*.test.ts"],
  },
});
