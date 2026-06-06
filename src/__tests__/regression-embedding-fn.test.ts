import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  loadStore,
  saveStore,
  clearStore,
  setNoteChunks,
  snapshotForTests,
  setMaxEmbeddingBytesForTests,
} from "../lib/embedding-store.js";
import {
  resetProviderForTests,
  setProviderForTests,
  getActiveProvider,
  type EmbeddingProvider,
} from "../lib/embedding-providers.js";
import { log } from "../lib/logger.js";
import { createTestEnv, isError, textContent, type TestEnv } from "./handlers/harness.js";

const INDEX_CONFIRM = "send-vault-text-to-embedding-provider";

// Regression coverage for the second wave of embedding-stack findings:
//   - FN-H1: OllamaProvider probe used to be followed by a full embedBatched
//          over the whole input, double-embedding chunk 0 on every cold
//          start. The probe's vector must now be reused.
//   - FN-M1: saveStore was unbounded. A multi-GB snapshot would happily
//          churn the disk on every index pass; we now skip the write and
//          log when the serialized snapshot exceeds MAX_EMBEDDING_BYTES.
//   - FN-M2: index_vault held no top-level lock, so two parallel calls
//          could interleave setNoteChunks / pruneMissingNotes against the
//          same store. The handler now serializes on the per-vault rewrite
//          lock so one call's work fully precedes the other's.

// ─── FN-H1: probe vector reuse ──────────────────────────────────────

describe("OllamaProvider probe vector reuse (FN-H1)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetProviderForTests();
    process.env.OBSIDIAN_EMBEDDING_PROVIDER = "ollama";
    process.env.OBSIDIAN_EMBEDDING_URL = "http://localhost:11434";
    process.env.OBSIDIAN_EMBEDDING_MODEL = "test-model";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setProviderForTests(null);
    resetProviderForTests();
    delete process.env.OBSIDIAN_EMBEDDING_PROVIDER;
    delete process.env.OBSIDIAN_EMBEDDING_URL;
    delete process.env.OBSIDIAN_EMBEDDING_MODEL;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("cold start over 10 texts issues probe(1) + batch(9), not probe(1) + batch(10)", async () => {
    const provider = getActiveProvider();
    expect(provider).not.toBeNull();

    // Deterministic, distinguishable vectors per input so we can verify
    // chunk 0 carries the probe's vector specifically.
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const inputs = body.input ?? [];
      return jsonResponse({
        embeddings: inputs.map((s) => [s.charCodeAt(0), s.length, 0]),
      });
    });
    globalThis.fetch = fetchMock;

    const texts = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const vectors = await provider!.embed(texts);

    // We get back one vector per input.
    expect(vectors).toHaveLength(10);

    // Critical: 2 fetch calls, not 11.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const probeBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const batchBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect((probeBody.input as unknown[]).length).toBe(1);
    // The followup batch covers only the 9 remaining texts — the probe's
    // vector is reused for texts[0], not re-requested.
    expect((batchBody.input as unknown[]).length).toBe(9);
    // The followup batch must NOT contain the probe's input.
    expect((batchBody.input as string[]).includes("a")).toBe(false);

    // Chunk 0's returned vector must equal what the probe call produced.
    // Probe responded with `[char('a'), 1, 0]` = `[97, 1, 0]`.
    expect(vectors[0]).toEqual([97, 1, 0]);
  });

  it("a single-text cold-start call uses the probe only (no followup batch)", async () => {
    const provider = getActiveProvider();
    expect(provider).not.toBeNull();

    const fetchMock = vi.fn(async () =>
      jsonResponse({ embeddings: [[1, 2, 3]] }),
    );
    globalThis.fetch = fetchMock;

    const vectors = await provider!.embed(["only-one"]);
    expect(vectors).toEqual([[1, 2, 3]]);
    // The probe already covered the single input; no second call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warm path (after a successful probe) batches all inputs in one call", async () => {
    const provider = getActiveProvider();
    expect(provider).not.toBeNull();

    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const inputs = body.input ?? [];
      return jsonResponse({ embeddings: inputs.map(() => [1, 2, 3]) });
    });
    globalThis.fetch = fetchMock;

    // Cold call warms the provider: probe(1) + batch(2).
    await provider!.embed(["a", "b", "c"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();

    // Second call is warm — no probe, one batched fetch covering all 4.
    await provider!.embed(["w", "x", "y", "z"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const warmBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect((warmBody.input as unknown[]).length).toBe(4);
  });
});

// ─── FN-M1: snapshot size cap ───────────────────────────────────────

describe("saveStore enforces MAX_EMBEDDING_BYTES (FN-M1)", () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-cap-"));
  });

  afterEach(async () => {
    setMaxEmbeddingBytesForTests(null);
    await clearStore(vaultDir, { removeSnapshot: true });
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("skips the write and logs a warning when the serialized snapshot exceeds the cap", async () => {
    // Drop the cap to something tiny so a single chunk overflows.
    setMaxEmbeddingBytesForTests(100);

    await loadStore(vaultDir);
    // Vector long enough that the JSON-serialized snapshot exceeds 100 bytes.
    const vector = Array.from({ length: 64 }, (_, i) => i / 64);
    setNoteChunks(
      vaultDir,
      "big.md",
      "h",
      [{ notePath: "big.md", chunkIndex: 1, headingPath: [], text: "x", hash: "th", vector }],
      "test",
      "m",
    );

    const warnSpy = vi.spyOn(log, "warn");
    await saveStore(vaultDir);

    // The snapshot file must NOT have been written to disk.
    const file = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-embeddings.json");
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });

    // Confirm we emitted the expected warning.
    const matched = warnSpy.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("MAX_EMBEDDING_BYTES"),
    );
    expect(matched).toBeDefined();

    // In-memory state should still hold the data; only persistence was skipped.
    expect(snapshotForTests(vaultDir).totalChunks).toBe(1);

    warnSpy.mockRestore();
  });

  it("persists normally when the snapshot fits under the cap", async () => {
    setMaxEmbeddingBytesForTests(1024 * 1024); // 1MB — plenty for one chunk.

    await loadStore(vaultDir);
    setNoteChunks(
      vaultDir,
      "small.md",
      "h",
      [{ notePath: "small.md", chunkIndex: 1, headingPath: [], text: "x", hash: "th", vector: [1, 2, 3] }],
      "test",
      "m",
    );

    await saveStore(vaultDir);
    const file = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-embeddings.json");
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as { embeddings: unknown[] };
    expect(parsed.embeddings).toHaveLength(1);
  });
});

// ─── FN-M2: parallel index_vault calls serialize ────────────────────

describe("index_vault per-vault serialization (FN-M2)", () => {
  let env: TestEnv;
  // Records the ordering of provider.embed start/end events. If two
  // index_vault calls interleave their embed work, we'll see start_A then
  // start_B before either ends — that's exactly the corruption case the
  // top-level lock prevents.
  const events: Array<{ tag: string; at: number }> = [];

  class TaggingProvider implements EmbeddingProvider {
    readonly id = "mock-tag";
    readonly model = "m";
    constructor(private tag: string) {}
    async embed(texts: string[]): Promise<number[][]> {
      events.push({ tag: `start:${this.tag}`, at: Date.now() });
      // Yield to the event loop several times so a concurrent call has a
      // chance to interleave if the index_vault lock isn't holding.
      await new Promise((r) => setTimeout(r, 20));
      events.push({ tag: `end:${this.tag}`, at: Date.now() });
      return texts.map(() => [1, 0, 0]);
    }
  }

  beforeEach(async () => {
    events.length = 0;
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "a.md": "# A\n\nalpha contents",
        "b.md": "# B\n\nbravo contents",
        "c.md": "# C\n\ncharlie contents",
      },
    });
  });

  afterEach(async () => {
    setProviderForTests(null);
    resetProviderForTests();
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
  });

  it("two parallel index_vault calls serialize: one fully precedes the other", async () => {
    // Both calls share a provider that records start/end markers. With the
    // per-vault lock in place, all "start:A" events must complete before
    // any "start:B" event begins (or vice versa).
    setProviderForTests(new TaggingProvider("A"));

    const [r1, r2] = await Promise.all([
      env.client.callTool({ name: "index_vault", arguments: { confirm: INDEX_CONFIRM } }),
      env.client.callTool({ name: "index_vault", arguments: { confirm: INDEX_CONFIRM } }),
    ]);

    expect(isError(r1)).toBe(false);
    expect(isError(r2)).toBe(false);

    // We expect a clean run of start/end pairs that never overlap. Read
    // the event log and confirm no "start" occurred while another was open.
    let depth = 0;
    let maxDepth = 0;
    for (const ev of events) {
      if (ev.tag.startsWith("start:")) depth++;
      if (ev.tag.startsWith("end:")) depth--;
      maxDepth = Math.max(maxDepth, depth);
    }
    expect(maxDepth).toBe(1);

    // The final store should reflect ALL three notes embedded — neither
    // call's prune wiped the other's work.
    const snap = snapshotForTests(env.vaultDir);
    expect(snap.totalNotes).toBe(3);
  });
});

describe("index_vault partial-note failures", () => {
  let env: TestEnv;

  class PartialProvider implements EmbeddingProvider {
    readonly id = "mock-partial";
    readonly model = "m";
    constructor(private readonly complete: boolean) {}
    async embed(texts: string[]): Promise<number[][]> {
      if (this.complete) return texts.map(() => [1, 0, 0]);
      return texts.map((_, index) =>
        index === 0 ? [1, 0, 0] : undefined as unknown as number[],
      );
    }
  }

  beforeEach(async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "multi.md": "# Alpha\n\nalpha body\n\n# Beta\n\nbeta body",
      },
    });
  });

  afterEach(async () => {
    setProviderForTests(null);
    resetProviderForTests();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    await env.cleanup();
  });

  it("does not mark a note current unless every chunk embeds successfully", async () => {
    setProviderForTests(new PartialProvider(false));
    const partial = await env.client.callTool({ name: "index_vault", arguments: { confirm: INDEX_CONFIRM } });
    expect(isError(partial)).toBe(false);
    expect(textContent(partial)).toMatch(/Failures:\s+1/);
    expect(snapshotForTests(env.vaultDir).totalChunks).toBe(0);
    expect(snapshotForTests(env.vaultDir).totalNotes).toBe(0);

    setProviderForTests(new PartialProvider(true));
    const complete = await env.client.callTool({ name: "index_vault", arguments: { confirm: INDEX_CONFIRM } });
    expect(isError(complete)).toBe(false);
    expect(textContent(complete)).toContain("Notes embedded:  1");
    expect(snapshotForTests(env.vaultDir).totalChunks).toBe(2);
    expect(snapshotForTests(env.vaultDir).totalNotes).toBe(1);
  });
});
