import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";
import {
  setProviderForTests,
  resetProviderForTests,
  type EmbeddingProvider,
} from "../lib/embedding-providers.js";
import { clearStore } from "../lib/embedding-store.js";

// ---------------------------------------------------------------------------
// M8: index_vault must not inflate `chunksEmbedded` on partial batch failure.
//
// Original bug: stats.chunksEmbedded was incremented batch-wide (`+= batch.length`)
// even when individual entries within the batch had no vector returned by the
// provider (pushed to stats.failed instead). The reported "Chunks embedded"
// figure therefore over-counted by exactly the number of failed entries.
//
// Fix: increment per-chunk INSIDE the loop, only after the Array.isArray check
// passes. The failed branch already `continue`s so it correctly skips the
// increment.
// ---------------------------------------------------------------------------

/**
 * Provider that returns a vector for every Nth input and a non-array
 * sentinel (here: `null` cast to any) for the rest. The semantic indexer
 * uses `Array.isArray` to gate validity, so this exercises the failed-path
 * accounting without faking a network error.
 *
 * Tracks the running text count so the pattern survives across batches
 * (EMBED_BATCH_SIZE = 16). Texts at indices where index % invalidEvery === 0
 * are invalid (returning a non-array); all others are valid.
 */
class PartiallyFailingProvider implements EmbeddingProvider {
  readonly id = "mock-partial";
  readonly model = "partial-failer";
  private seen = 0;
  validCount = 0;
  invalidCount = 0;

  constructor(private readonly invalidEvery: number) {}

  embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const _t of texts) {
      const idx = this.seen++;
      if (idx % this.invalidEvery === 0) {
        // Non-array entry. Cast through unknown so the array type stays
        // happy at compile time; runtime is the only thing that matters
        // for the Array.isArray check in the indexer.
        out.push(null as unknown as number[]);
        this.invalidCount++;
      } else {
        out.push([0.1, 0.2, 0.3, 0.4]);
        this.validCount++;
      }
    }
    return Promise.resolve(out);
  }
}

let env: TestEnv;
let provider: PartiallyFailingProvider;

beforeEach(async () => {
  provider = new PartiallyFailingProvider(3); // every 3rd chunk is invalid
  setProviderForTests(provider);
  // Several short notes so chunking yields > 1 chunk per note and we cross
  // the batch boundary at index 16. The exact contents don't matter — only
  // the chunk count does — but distinct text keeps content hashes distinct.
  const extraFiles: Record<string, string> = {};
  for (let i = 0; i < 10; i++) {
    extraFiles[`note-${i}.md`] = `# Note ${i}\n\nBody for note ${i}. Some text to chunk.\n`;
  }
  env = await createTestEnv({ skipFixtures: true, extraFiles });
});

afterEach(async () => {
  await clearStore(env.vaultDir, { removeSnapshot: true });
  await env.cleanup();
  resetProviderForTests();
});

describe("M8: index_vault chunksEmbedded reflects only successful embeddings", () => {
  it("reports chunksEmbedded == valid vectors and failures == invalid vectors", async () => {
    const result = await env.client.callTool({
      name: "index_vault",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);

    // Indexer pushed (validCount + invalidCount) chunks at the provider;
    // post-fix it should report exactly validCount embedded and invalidCount
    // failed. Pre-fix, "Chunks embedded" equals the full batch sum and
    // overshoots by invalidCount.
    const embeddedMatch = text.match(/Chunks embedded:\s+(\d+)/);
    const failedMatch = text.match(/Failures:\s+(\d+)/);
    expect(embeddedMatch).not.toBeNull();
    expect(failedMatch).not.toBeNull();

    const embedded = Number.parseInt(embeddedMatch![1], 10);
    const failed = Number.parseInt(failedMatch![1], 10);

    expect(provider.invalidCount).toBeGreaterThan(0);
    expect(provider.validCount).toBeGreaterThan(0);
    expect(embedded).toBe(provider.validCount);
    expect(failed).toBe(provider.invalidCount);
    // The two should sum to the total chunks the provider saw, which is the
    // sum of provider.validCount + provider.invalidCount.
    expect(embedded + failed).toBe(provider.validCount + provider.invalidCount);
  });
});
