import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const legacyEmbeddingStoreAdapter = fileURLToPath(
  new URL(
    "./src/__tests__/embedding-store-legacy-adapter.ts",
    import.meta.url
  )
);

export default defineConfig({
  test: {
    alias: [
      {
        find: "../lib/embedding-store.js",
        replacement: legacyEmbeddingStoreAdapter,
      },
      {
        find: "../../lib/embedding-store.js",
        replacement: legacyEmbeddingStoreAdapter,
      },
    ],
    globals: true,
    maxWorkers: 1,
    testTimeout: 30000,
    include: ["src/__tests__/**/*.test.ts"],
  },
});
