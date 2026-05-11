import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  loadStore,
  saveStore,
  clearStore,
  setNoteChunks,
  searchEmbeddings,
  snapshotForTests,
} from "../lib/embedding-store.js";
import {
  resetProviderForTests,
  setProviderForTests,
  getActiveProvider,
} from "../lib/embedding-providers.js";

// Regression coverage for three embedding-stack audit findings:
//   - H10: saveStore tmp not cleaned up on rename failure, and the tmp name
//          was deterministic per-PID so concurrent saves could collide.
//   - #24 (LOW): loadStore accepted any vector; mismatched-dimension entries
//          must be silently dropped to guard against hand-edited snapshots.
//   - M16: OllamaProvider probed batch with the full input, so a transient
//          error retried the full batch every call instead of re-probing
//          cheaply.

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-regression-"));
});

afterEach(async () => {
  await clearStore(vaultDir, { removeSnapshot: true });
  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ─── H10: saveStore tmp hygiene ─────────────────────────────────────

describe("saveStore tmp hygiene (H10)", () => {
  const STORE_REL = ".obsidian/cache/mcp-pro-embeddings.json";

  it("does not leave a tmp file behind after a successful save", async () => {
    await loadStore(vaultDir);
    setNoteChunks(
      vaultDir,
      "a.md",
      "h",
      [{ notePath: "a.md", chunkIndex: 1, headingPath: [], text: "x", hash: "th", vector: [1, 2, 3] }],
      "test",
      "m",
    );
    await saveStore(vaultDir);

    const cacheDir = path.join(vaultDir, ".obsidian", "cache");
    const entries = await fs.readdir(cacheDir);
    // The final file is allowed; no leftover .tmp siblings should exist.
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("mcp-pro-embeddings.json");
  });

  it("uses a random tmp suffix so two concurrent saves in the same PID don't collide", async () => {
    // Drive two saves through the same process. With a deterministic
    // `${file}.${pid}.tmp` name, the second writeFile would either overwrite
    // the first's tmp or be racing with its rename — at best you get the
    // wrong contents on disk, at worst an EPERM/ENOENT. With a random
    // suffix the two flows are independent and both end up with the same
    // final file content.
    await loadStore(vaultDir);
    setNoteChunks(
      vaultDir,
      "a.md",
      "h1",
      [{ notePath: "a.md", chunkIndex: 1, headingPath: [], text: "x", hash: "th", vector: [1, 0, 0] }],
      "test",
      "m",
    );
    // Force dirty before each save by mutating; saveStore is a no-op when
    // !dirty, so just calling it twice in a row would skip the second.
    await Promise.all([saveStore(vaultDir), saveStore(vaultDir)]);

    const cacheDir = path.join(vaultDir, ".obsidian", "cache");
    const entries = await fs.readdir(cacheDir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans up the tmp file when rename fails", async () => {
    await loadStore(vaultDir);
    setNoteChunks(
      vaultDir,
      "a.md",
      "h",
      [{ notePath: "a.md", chunkIndex: 1, headingPath: [], text: "x", hash: "th", vector: [1, 2, 3] }],
      "test",
      "m",
    );

    // Make rename fail. The saveStore catch should unlink the tmp so we
    // don't accumulate orphan files on a flaky disk / EXDEV / antivirus
    // lock scenario.
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("simulated EPERM"), { code: "EPERM" }));

    await saveStore(vaultDir);

    const cacheDir = path.join(vaultDir, ".obsidian", "cache");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(cacheDir);
    } catch {
      // Directory may not exist if mkdir also failed; that's fine for this
      // assertion — there's certainly no leftover tmp.
    }
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    // The real snapshot file should not have been produced either, because
    // rename was the failing step.
    expect(entries).not.toContain(path.basename(STORE_REL));

    renameSpy.mockRestore();
  });
});

// ─── #24: snapshot dimension validation ─────────────────────────────

describe("snapshot dimension validation (finding #24)", () => {
  it("silently drops entries whose vector length doesn't match snapshot.dimension", async () => {
    const file = path.join(vaultDir, ".obsidian", "cache", "mcp-pro-embeddings.json");
    await fs.mkdir(path.dirname(file), { recursive: true });

    const snapshot = {
      version: 1,
      vaultRoot: path.resolve(vaultDir),
      providerId: "test",
      model: "m",
      dimension: 3,
      noteHashes: { "good.md": "h1", "bad.md": "h2" },
      embeddings: [
        { notePath: "good.md", chunkIndex: 1, headingPath: [], text: "g", hash: "gh", vector: [1, 0, 0] },
        // Wrong length — should be dropped on load without affecting siblings.
        { notePath: "bad.md", chunkIndex: 1, headingPath: [], text: "b", hash: "bh", vector: [1, 0] },
        { notePath: "good.md", chunkIndex: 2, headingPath: [], text: "g2", hash: "gh2", vector: [0, 1, 0] },
      ],
    };
    await fs.writeFile(file, JSON.stringify(snapshot), "utf-8");

    await loadStore(vaultDir);
    const snap = snapshotForTests(vaultDir);
    // Two good entries kept, one bad entry dropped.
    expect(snap.totalChunks).toBe(2);

    const hits = searchEmbeddings(vaultDir, [1, 0, 0], { limit: 10 });
    expect(hits.map((h) => h.notePath).sort()).toEqual(["good.md"]);
    // The bad-dimension entry must NOT appear in any result.
    const allNotes = new Set(hits.map((h) => h.notePath));
    expect(allNotes.has("bad.md")).toBe(false);
  });
});

// ─── M16: Ollama batch probe re-probes after transient failure ──────

describe("OllamaProvider probe (M16)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetProviderForTests();
    delete process.env.OBSIDIAN_EMBEDDING_PROVIDER;
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

  it("probes with a single-item request, not the full batch", async () => {
    const provider = getActiveProvider();
    expect(provider).not.toBeNull();

    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
      // Probe call must carry exactly one input.
      expect(Array.isArray(body.input)).toBe(true);
      expect((body.input as unknown[]).length).toBe(1);
      return jsonResponse({ embeddings: [[1, 2, 3]] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // First real call: 5 texts. Probe sees 1, then the real batched call
    // sees 5.
    const fetchMockReal = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
      const inputs = body.input as unknown[];
      // Always return one vector per input.
      return jsonResponse({ embeddings: inputs.map(() => [1, 2, 3]) });
    });
    globalThis.fetch = fetchMockReal as unknown as typeof fetch;

    const vectors = await provider!.embed(["a", "b", "c", "d", "e"]);
    expect(vectors).toHaveLength(5);
    // 2 calls total: one probe (1 input) + one real batch (4 inputs).
    // After FN-H1: the probe's vector is reused for texts[0] so the
    // followup batch only embeds the remaining 4 texts (not all 5).
    expect(fetchMockReal).toHaveBeenCalledTimes(2);
    const firstCallBody = JSON.parse(String((fetchMockReal.mock.calls[0][1] as RequestInit).body));
    const secondCallBody = JSON.parse(String((fetchMockReal.mock.calls[1][1] as RequestInit).body));
    expect((firstCallBody.input as unknown[]).length).toBe(1);
    expect((secondCallBody.input as unknown[]).length).toBe(4);
  });

  it("re-probes on the next call after a transient (non-404) probe failure", async () => {
    const provider = getActiveProvider();
    expect(provider).not.toBeNull();

    let call = 0;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      call++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
      const inputs = body.input as unknown[];
      if (call === 1) {
        // Probe attempt 1: transient failure (e.g. timeout / 500).
        return new Response("upstream timeout", { status: 503 });
      }
      // Subsequent calls succeed.
      return jsonResponse({ embeddings: inputs.map(() => [9, 9, 9]) });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // First call should reject — the probe failed for a non-404 reason and
    // we don't silently downgrade to per-item on transient errors.
    await expect(provider!.embed(["a", "b"])).rejects.toThrow();

    // Second call must re-probe (batchSupported stayed null). With the
    // mock now returning 200, this call succeeds: probe (1 input) +
    // real batched call (2 inputs).
    const vectors = await provider!.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);

    // Call ledger: failed probe, successful probe, real batched call.
    // After FN-H1: the successful probe's vector is reused for texts[0]
    // so the followup batched call only carries the remaining 1 input.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const probeBody1 = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const probeBody2 = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    const realBody = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body));
    expect((probeBody1.input as unknown[]).length).toBe(1);
    expect((probeBody2.input as unknown[]).length).toBe(1);
    expect((realBody.input as unknown[]).length).toBe(1);
  });

  it("falls back to per-item when probe returns 404 and does not re-probe later", async () => {
    const provider = getActiveProvider();
    expect(provider).not.toBeNull();

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        // Batched endpoint missing on this Ollama install.
        return new Response("not found", { status: 404 });
      }
      // Per-item endpoint succeeds.
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      expect(typeof body.prompt).toBe("string");
      return jsonResponse({ embedding: [0.1, 0.2, 0.3] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out1 = await provider!.embed(["a", "b"]);
    expect(out1).toHaveLength(2);
    const out2 = await provider!.embed(["c"]);
    expect(out2).toHaveLength(1);

    // Count how many times the batched endpoint was attempted. Should be
    // exactly once (the cold-start probe); subsequent calls go straight to
    // per-item.
    const batchedAttempts = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/api/embed"),
    ).length;
    expect(batchedAttempts).toBe(1);
  });
});
