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

  it("returns 0 for length mismatch instead of throwing", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
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
});
