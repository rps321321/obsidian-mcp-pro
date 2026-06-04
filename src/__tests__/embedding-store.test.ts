import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  loadStore,
  saveStore,
  hashText,
  noteIsCurrent,
  setNoteChunks,
  pruneMissingNotes,
  searchEmbeddings,
  cosineSimilarity,
  getNoteEmbeddings,
  buildSimilarNotesQueryVector,
  clearStore,
  snapshotForTests,
  invalidateIfIncompatible,
} from "../lib/embedding-store.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-store-"));
});

afterEach(async () => {
  await clearStore(vaultDir, { removeSnapshot: true });
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function linkCacheDirOutside(outsideDir: string): Promise<boolean> {
  await fs.mkdir(path.join(vaultDir, ".obsidian"), { recursive: true });
  try {
    await fs.symlink(
      outsideDir,
      path.join(vaultDir, ".obsidian", "cache"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EINVAL") return false;
    throw err;
  }
}

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1.0, 5);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("dimension mismatch");
  });
});

describe("setNoteChunks / searchEmbeddings", () => {
  it("stores chunks and finds the closest by cosine similarity", async () => {
    await loadStore(vaultDir);
    setNoteChunks(
      vaultDir,
      "alpha.md",
      hashText("alpha"),
      [{ notePath: "alpha.md", chunkIndex: 1, headingPath: [], text: "cats", hash: "h1", vector: [1, 0, 0] }],
      "test",
      "test-model",
    );
    setNoteChunks(
      vaultDir,
      "beta.md",
      hashText("beta"),
      [{ notePath: "beta.md", chunkIndex: 1, headingPath: [], text: "dogs", hash: "h2", vector: [0, 1, 0] }],
      "test",
      "test-model",
    );

    const hits = searchEmbeddings(vaultDir, [0.99, 0.01, 0], { limit: 5 });
    expect(hits).toHaveLength(2);
    expect(hits[0].notePath).toBe("alpha.md");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("dedups to one hit per note (best chunk wins)", async () => {
    await loadStore(vaultDir);
    setNoteChunks(
      vaultDir,
      "doc.md",
      hashText("doc"),
      [
        { notePath: "doc.md", chunkIndex: 1, headingPath: [], text: "a", hash: "x1", vector: [1, 0, 0] },
        { notePath: "doc.md", chunkIndex: 2, headingPath: [], text: "b", hash: "x2", vector: [0.9, 0.1, 0] },
      ],
      "test",
      "test-model",
    );
    const hits = searchEmbeddings(vaultDir, [1, 0, 0], { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].chunkIndex).toBe(1);
  });

  it("ranks focused multi-chunk notes ahead of incidental single-chunk matches", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "kitchen-with-cat.md", hashText("kitchen"), [
      { notePath: "kitchen-with-cat.md", chunkIndex: 1, headingPath: ["Kitchen"], text: "one cat anecdote", hash: "h1", vector: [1, 0, 0] },
      { notePath: "kitchen-with-cat.md", chunkIndex: 2, headingPath: ["Recipes"], text: "recipes", hash: "h2", vector: [0, 1, 0] },
      { notePath: "kitchen-with-cat.md", chunkIndex: 3, headingPath: ["Oven"], text: "oven", hash: "h3", vector: [0, 1, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "cats-care.md", hashText("cats"), [
      { notePath: "cats-care.md", chunkIndex: 1, headingPath: ["Cats", "Care"], text: "cat care", hash: "h4", vector: [0.98, 0.05, 0] },
      { notePath: "cats-care.md", chunkIndex: 2, headingPath: ["Cats", "Behavior"], text: "cat behavior", hash: "h5", vector: [0.96, 0.08, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "cat-health.md", hashText("health"), [
      { notePath: "cat-health.md", chunkIndex: 1, headingPath: ["Cats", "Health"], text: "cat health", hash: "h6", vector: [0.97, 0.06, 0] },
      { notePath: "cat-health.md", chunkIndex: 2, headingPath: ["Cats", "Symptoms"], text: "cat symptoms", hash: "h7", vector: [0.93, 0.1, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "pet-overview.md", hashText("pets"), [
      { notePath: "pet-overview.md", chunkIndex: 1, headingPath: ["Pets"], text: "mixed pets", hash: "h8", vector: [0.85, 0.2, 0] },
      { notePath: "pet-overview.md", chunkIndex: 2, headingPath: ["Budget"], text: "pet budget", hash: "h9", vector: [0.75, 0.25, 0] },
    ], "test", "m");

    const hits = searchEmbeddings(vaultDir, [1, 0, 0], { limit: 4 });
    expect(hits.map((hit) => hit.notePath)).toEqual([
      "cats-care.md",
      "cat-health.md",
      "pet-overview.md",
      "kitchen-with-cat.md",
    ]);
    expect(hits[0].chunkIndex).toBe(1);
  });

  it("filters by folder prefix", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "projects/alpha.md", hashText("a"), [
      { notePath: "projects/alpha.md", chunkIndex: 1, headingPath: [], text: "p", hash: "h", vector: [1, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "drafts/beta.md", hashText("b"), [
      { notePath: "drafts/beta.md", chunkIndex: 1, headingPath: [], text: "d", hash: "h", vector: [1, 0] },
    ], "test", "m");

    const hits = searchEmbeddings(vaultDir, [1, 0], { limit: 5, folder: "projects" });
    expect(hits.map((h) => h.notePath)).toEqual(["projects/alpha.md"]);
  });

  it("excludes the source note when find-similar passes excludeNotes", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "self.md", hashText("s"), [
      { notePath: "self.md", chunkIndex: 1, headingPath: [], text: "x", hash: "h", vector: [1, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "other.md", hashText("o"), [
      { notePath: "other.md", chunkIndex: 1, headingPath: [], text: "y", hash: "h", vector: [1, 0] },
    ], "test", "m");
    const hits = searchEmbeddings(vaultDir, [1, 0], { excludeNotes: new Set(["self.md"]) });
    expect(hits.map((h) => h.notePath)).toEqual(["other.md"]);
  });

  it("anchors similar-note queries to the source note's opening topic", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "source-cat-care.md", hashText("source"), [
      { notePath: "source-cat-care.md", chunkIndex: 1, headingPath: ["Cats", "Care"], text: "cat care", hash: "h1", vector: [1, 0, 0] },
      { notePath: "source-cat-care.md", chunkIndex: 2, headingPath: ["Appendix"], text: "recipe appendix", hash: "h2", vector: [0.1, 1, 0] },
      { notePath: "source-cat-care.md", chunkIndex: 3, headingPath: ["Appendix"], text: "kitchen appendix", hash: "h3", vector: [0.1, 1, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "cats-care.md", hashText("cats"), [
      { notePath: "cats-care.md", chunkIndex: 1, headingPath: ["Cats", "Care"], text: "focused cat care", hash: "h4", vector: [0.98, 0.05, 0] },
      { notePath: "cats-care.md", chunkIndex: 2, headingPath: ["Cats", "Behavior"], text: "cat behavior", hash: "h5", vector: [0.96, 0.08, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "cat-health.md", hashText("health"), [
      { notePath: "cat-health.md", chunkIndex: 1, headingPath: ["Cats", "Health"], text: "cat health", hash: "h6", vector: [0.97, 0.04, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "pet-overview.md", hashText("pets"), [
      { notePath: "pet-overview.md", chunkIndex: 1, headingPath: ["Pets"], text: "mixed pets", hash: "h7", vector: [0.75, 0.25, 0] },
    ], "test", "m");
    setNoteChunks(vaultDir, "kitchen-recipes.md", hashText("kitchen"), [
      { notePath: "kitchen-recipes.md", chunkIndex: 1, headingPath: ["Kitchen"], text: "recipes", hash: "h8", vector: [0, 1, 0] },
    ], "test", "m");

    const queryVector = buildSimilarNotesQueryVector(
      getNoteEmbeddings(vaultDir, "source-cat-care.md"),
    );
    const hits = searchEmbeddings(vaultDir, queryVector, {
      limit: 4,
      excludeNotes: new Set(["source-cat-care.md"]),
    });

    expect(queryVector[0]).toBeGreaterThan(queryVector[1]!);
    expect(hits.map((hit) => hit.notePath)).toEqual([
      "cats-care.md",
      "cat-health.md",
      "pet-overview.md",
      "kitchen-recipes.md",
    ]);
    expect(hits[0].headingPath[0]).toBe("Cats");
  });
});

describe("noteIsCurrent / pruneMissingNotes", () => {
  it("noteIsCurrent returns true only for matching content hashes", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "a.md", "hash1", [
      { notePath: "a.md", chunkIndex: 1, headingPath: [], text: "t", hash: "th", vector: [1] },
    ], "test", "m");
    expect(noteIsCurrent(vaultDir, "a.md", "hash1")).toBe(true);
    expect(noteIsCurrent(vaultDir, "a.md", "hashOther")).toBe(false);
    expect(noteIsCurrent(vaultDir, "missing.md", "anything")).toBe(false);
  });

  it("pruneMissingNotes drops chunks for notes not in the live set", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "alive.md", "h1", [
      { notePath: "alive.md", chunkIndex: 1, headingPath: [], text: "t", hash: "th", vector: [1] },
    ], "test", "m");
    setNoteChunks(vaultDir, "dead.md", "h2", [
      { notePath: "dead.md", chunkIndex: 1, headingPath: [], text: "t", hash: "th", vector: [1] },
    ], "test", "m");
    const pruned = pruneMissingNotes(vaultDir, ["alive.md"]);
    expect(pruned).toBe(1);
    const snap = snapshotForTests(vaultDir);
    expect(snap.totalNotes).toBe(1);
  });
});

describe("snapshot persistence", () => {
  it("round-trips through disk", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "a.md", "h1", [
      { notePath: "a.md", chunkIndex: 1, headingPath: ["A"], text: "Hello", hash: "th", vector: [1, 2, 3] },
    ], "ollama", "nomic-embed-text");
    await saveStore(vaultDir);

    await clearStore(vaultDir);
    await loadStore(vaultDir);
    const hits = searchEmbeddings(vaultDir, [1, 2, 3], { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].notePath).toBe("a.md");
    expect(hits[0].headingPath).toEqual(["A"]);
  });

  it("invalidateIfIncompatible clears entries when provider/model differ", async () => {
    await loadStore(vaultDir);
    setNoteChunks(vaultDir, "a.md", "h", [
      { notePath: "a.md", chunkIndex: 1, headingPath: [], text: "x", hash: "h", vector: [1] },
    ], "ollama", "model-a");
    invalidateIfIncompatible(vaultDir, "ollama", "model-b");
    expect(snapshotForTests(vaultDir).totalChunks).toBe(0);
  });

  it("does not persist through a .obsidian/cache symlink outside the vault", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "embed-outside-"));
    try {
      const linked = await linkCacheDirOutside(outsideDir);
      if (!linked) return;

      await loadStore(vaultDir);
      setNoteChunks(vaultDir, "a.md", "h", [
        { notePath: "a.md", chunkIndex: 1, headingPath: [], text: "x", hash: "h", vector: [1] },
      ], "ollama", "model-a");
      await saveStore(vaultDir);

      await expect(
        fs.access(path.join(outsideDir, "mcp-pro-embeddings.json")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
